# Terrain Generation & Erosion Algorithms (Implementation-Grade)

**Contents:** [0 Conventions & memory](#0-conventions-data-model-and-memory-budget) ·
[1 Noise](#1-noise) · [2 Hydraulic erosion](#2-hydraulic-erosion) ·
[3 Thermal erosion](#3-thermal-erosion--talus) ·
[4 SPL / Cordonnier / Guérin](#4-advanced-landscape-evolution-models-and-amplification) ·
[5 Flow & drainage](#5-flow-direction-accumulation-depressions-watersheds-rivers) ·
[6 Derived maps](#6-derived-maps-for-texturing-and-gameplay) ·
[7 Shaping operators](#7-shaping-operators-terracing-canyons-coasts-snow-alluvial-fans) ·
[8 Layout generator](#8-constraint-driven-shaping-for-gameplay-layout-generator) ·
[9 WebGPU practicalities](#9-gpu-practicalities-in-webgpu) ·
[10 Precision & uint16](#10-precision-f32-in-the-pipeline-uint16-at-the-door) ·
[11 Appendix](#11-appendix)

> Target audience: an engineer writing these in **WGSL/GLSL compute shaders + TypeScript** (WebGPU first,
> WebGL2 fallback). Everything here is meant to be implementable without re-reading the papers.
> Formulas that are quoted verbatim from a source are marked **[quoted]** with a page/equation/line ref;
> formulas I derived (stability bounds, closed forms) are marked **[derived]**.

---

## 0. Conventions, data model, and memory budget

### 0.1 Field naming (used consistently below)

| Symbol | Meaning | Type | Notes |
|---|---|---|---|
| `b(x,y)` | bedrock / terrain height | f32 | the thing you export |
| `d(x,y)` | water column height | f32 | pipe model only |
| `s(x,y)` | suspended sediment | f32 | pipe model only |
| `f(x,y)` | outflow flux `(fL,fR,fT,fB)` | vec4f | pipe model only |
| `v(x,y)` | horizontal water velocity `(u,v)` | vec2f | pipe model only |
| `A(x,y)` | drainage / flow accumulation area | f32 or u32 | cells or m² |
| `R(x,y)` | rock hardness / resistance ∈ [0,1] | f32 | optional, huge realism win |
| `lX, lY` | grid spacing in world units (m or elmos) | f32 uniform | |
| `N` | grid side length in cells | u32 | |

**Indexing convention.** Row-major, `idx = y * N + x`, origin top-left, `+y` = south. All 8-neighbour
loops use this order (matters for reproducibility and for D8 encodings):

```
7 0 1        (dx,dy) = (0,-1),(1,-1),(1,0),(1,1),(0,1),(-1,1),(-1,0),(-1,-1)
6 . 2        index:      0      1     2     3     4      5      6       7
5 4 3
```

**Height normalization.** Run *all* simulation in normalized height `h ∈ [0,1]` (or `[0, ~2]`), and convert
to world metres only at export. Rationale in §10: f32 ULP at `h≈1` is `1.19e-7`; at `h≈1000 m` it is
`6.1e-5 m`, which is 500× coarser and starts to swallow per-step erosion deltas of `1e-5`.

### 0.2 Canonical GPU layout (WGSL, std430-equivalent storage buffer)

WGSL storage-buffer layout rules: `f32/i32/u32` → align 4, size 4; `vec2<f32>` → align 8, size 8;
`vec3<f32>` → align **16**, size **12** (the classic trap); `vec4<f32>` → align 16, size 16
([WGSL §14.4.4 "Alignment and Size"](https://www.w3.org/TR/WGSL/#alignment-and-size)).

Prefer **struct-of-arrays** (one buffer per field). It is faster (coalesced reads, no padding) and it lets
you ping-pong only the fields that change in a given pass.

If you insist on an interleaved cell struct, this is the exact layout:

```wgsl
struct Cell {          // offset  size  align
  b    : f32,          //      0     4      4
  d    : f32,          //      4     4      4
  s    : f32,          //      8     4      4
  hard : f32,          //     12     4      4
  flux : vec4<f32>,    //     16    16     16   // fL,fR,fT,fB
  vel  : vec2<f32>,    //     32     8      8
  _pad : vec2<f32>,    //     40     8      8
};                     // stride 48, align 16
```

Total **48 bytes/cell**. Note the required trailing pad: struct size must be a multiple of its alignment (16).

### 0.3 Worked memory budget

Cells = `N²`. Bytes for a field of type T = `N² · sizeof(T)`.

| N | cells | 1× f32 field | pipe-model SoA (b,d,s,flux,vel = 36 B) | + ping-pong on (d,s,flux,vel)=32 B |
|---|---|---|---|---|
| 1024 | 1,048,576 | 4 MiB | 36 MiB | 68 MiB |
| 2048 | 4,194,304 | 16 MiB | 144 MiB | 272 MiB |
| 4096 | 16,777,216 | 64 MiB | 576 MiB | 1088 MiB |
| 8192 | 67,108,864 | 256 MiB | 2304 MiB | 4352 MiB |

**Hard WebGPU limits you will hit** (defaults, [WebGPU §3.6.2 Limits](https://www.w3.org/TR/webgpu/#limits)):

* `maxStorageBufferBindingSize` = **134217728 (128 MiB)** → a single f32 heightfield binding caps at
  `N = 5792` (`5792² · 4 = 134.2 MB`). At `N = 8192` a f32 field is 256 MiB: you **must** raise the limit
  via `requiredLimits` (most desktop adapters report 2 GiB) or split into tiles/chunks.
* `maxBufferSize` = **268435456 (256 MiB)** default.
* `maxTextureDimension2D` = **8192** default (desktop adapters usually report 16384).
* `maxComputeWorkgroupsPerDimension` = **65535** → with `@workgroup_size(8,8)` you can dispatch
  `8·65535 = 524280` pixels per dimension; never a problem for heightfields.

**Practical ceiling:** on a mid-range laptop GPU, a full pipe-model hydraulic sim is comfortable at
**2048²**, tight at **4096²**, and needs tiling at 8192². Droplet erosion (§2.2) needs only the
heightfield, so 8192² is fine there (256 MiB single buffer, raise the limit).

### 0.4 Recommended pipeline order

```
1. base noise (fBm / ridged / warped)          §1
2. layout constraints: plateaus, ramps, sym.   §8   <- apply BEFORE erosion
3. tectonic / SPL pass (optional, large scale) §4
4. thermal erosion (coarse, ~20 passes)        §3
5. hydraulic erosion (pipe or droplet)         §2
6. thermal erosion (fine, ~10 passes)          §3
7. depression fill + flow accumulation         §5
8. river carving / canyonize / coast / snow    §7
9. re-apply gameplay constraints (feathered)   §8   <- AGAIN, erosion destroys flat pads
10. derived maps (slope/AO/wetness) for texture §6
11. quantize to uint16 with dithering          §10
```

The "apply constraints twice" rule is the single most important pipeline lesson: erosion will happily
carve a gully through your build pad.

---

## 1. Noise

### 1.1 Hashing and seeding (get this right first)

Every noise below needs a deterministic `hash(ivec) -> [0,1)` or `-> gradient`. On GPU, do **not** use
`fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453)` — it has platform-dependent `sin` precision and
visible structure. Use an integer bit-mixer.

```wgsl
// Wang / PCG-style 32-bit mixer. Exactly reproducible on CPU (TypeScript with >>> 0) and GPU.
fn hash_u32(x0: u32) -> u32 {
  var x = x0;
  x = x ^ (x >> 17u); x = x * 0xED5AD4BBu;
  x = x ^ (x >> 11u); x = x * 0xAC4C1B51u;
  x = x ^ (x >> 15u); x = x * 0x31848BABu;
  x = x ^ (x >> 14u);
  return x;
}
fn hash2(p: vec2<i32>, seed: u32) -> u32 {
  // 2D -> 1D via large odd primes; avoids the x==y symmetry artifact of x+y
  return hash_u32(u32(p.x) * 0x9E3779B1u ^ u32(p.y) * 0x85EBCA77u ^ seed);
}
fn hash_f01(p: vec2<i32>, seed: u32) -> f32 { return f32(hash2(p, seed)) * 2.3283064365386963e-10; } // /2^32
```

TypeScript mirror (must match bit-for-bit if you want CPU/GPU parity for previews):

```ts
const M = 0xFFFFFFFF;
function hashU32(x: number): number {
  x = (x ^ (x >>> 17)) >>> 0; x = Math.imul(x, 0xED5AD4BB) >>> 0;
  x = (x ^ (x >>> 11)) >>> 0; x = Math.imul(x, 0xAC4C1B51) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0x31848BAB) >>> 0;
  return (x ^ (x >>> 14)) >>> 0;
}
```

**Seeding strategy.** One global `u32 seed`. Derive per-layer seeds as `seed ^ hash_u32(layerIndex)`;
derive per-octave seeds as `layerSeed + octave * 0x9E3779B1`. Never seed by offsetting the *domain*
(`p + vec2(seed)`) — that correlates layers at large offsets and loses f32 precision (see §1.9).

### 1.2 Value noise (+ analytic derivatives)

Cheapest. Slightly blocky/axis-aligned; fine as a *detail* layer or a warp source, poor as a primary.

```wgsl
// returns vec3(value, ddx, ddy); value in [-1,1]
fn valueNoise2D(x: vec2<f32>, seed: u32) -> vec3<f32> {
  let p  = floor(x);
  let w  = fract(x);
  let u  = w*w*w*(w*(w*6.0-15.0)+10.0);         // quintic  C2
  let du = 30.0*w*w*(w*(w-2.0)+1.0);            // d/dw
  let ip = vec2<i32>(p);
  let a = hash_f01(ip + vec2<i32>(0,0), seed);
  let b = hash_f01(ip + vec2<i32>(1,0), seed);
  let c = hash_f01(ip + vec2<i32>(0,1), seed);
  let d = hash_f01(ip + vec2<i32>(1,1), seed);
  let k0 = a; let k1 = b-a; let k2 = c-a; let k3 = a-b-c+d;
  let val = k0 + k1*u.x + k2*u.y + k3*u.x*u.y;
  let grd = du * vec2<f32>(k1 + k3*u.y, k2 + k3*u.x);
  return vec3<f32>(-1.0 + 2.0*val, 2.0*grd);
}
```

The quintic `u = w³(6w²−15w+10)` and its derivative `du = 30w²(w−1)²` are exactly the pair used by
Inigo Quilez, ["Value noise derivatives"](https://iquilezles.org/articles/morenoise/) **[quoted]**.
Using the cubic smoothstep `w²(3−2w)` instead makes the *second* derivative discontinuous across cell
boundaries, which shows up as visible grid lines in curvature and AO maps (§6) even though it is invisible
in the height itself. **Always use quintic if you will differentiate the field.**

### 1.3 Perlin gradient noise (+ derivatives, tileable)

The standard terrain workhorse. Value range in 2D is `[-√2/2, +√2/2] ≈ [-0.7071, 0.7071]` for unit
gradients; multiply by `√2 ≈ 1.4142` to normalize to `[-1,1]` (people often forget, then wonder why
their fBm never reaches 1).

```wgsl
fn grad2(ip: vec2<i32>, seed: u32) -> vec2<f32> {
  // 8-direction gradient set: cheap, no trig, low directional bias for fBm
  let h = hash2(ip, seed) & 7u;
  let ang = f32(h) * 0.7853981633974483;         // pi/4
  return vec2<f32>(cos(ang), sin(ang));
}

// returns vec3(value, ddx, ddy), value ~ [-1,1] after the 1.4142 scale
fn perlin2D(x: vec2<f32>, seed: u32) -> vec3<f32> {
  let p = floor(x); let w = fract(x);
  let u  = w*w*w*(w*(w*6.0-15.0)+10.0);
  let du = 30.0*w*w*(w*(w-2.0)+1.0);
  let ip = vec2<i32>(p);
  let ga = grad2(ip+vec2<i32>(0,0),seed); let gb = grad2(ip+vec2<i32>(1,0),seed);
  let gc = grad2(ip+vec2<i32>(0,1),seed); let gd = grad2(ip+vec2<i32>(1,1),seed);
  let va = dot(ga, w - vec2<f32>(0.0,0.0));
  let vb = dot(gb, w - vec2<f32>(1.0,0.0));
  let vc = dot(gc, w - vec2<f32>(0.0,1.0));
  let vd = dot(gd, w - vec2<f32>(1.0,1.0));
  let k0=va; let k1=vb-va; let k2=vc-va; let k3=va-vb-vc+vd;
  let val = k0 + k1*u.x + k2*u.y + k3*u.x*u.y;
  // analytic gradient: d/dx of the bilerp of dot products, chain rule through u(w)
  let g = ga + u.x*(gb-ga) + u.y*(gc-ga) + u.x*u.y*(ga-gb-gc+gd)
        + du * vec2<f32>(k1 + k3*u.y, k2 + k3*u.x);
  return vec3<f32>(val, g) * 1.4142135623730951;
}
```

**Tileable variant.** Wrap the *lattice* index, not the domain. For a period `P` (in lattice cells)
replace every `grad2(ip+o, seed)` with `grad2(mod_p(ip+o, P), seed)` where

```wgsl
fn mod_p(v: vec2<i32>, P: vec2<i32>) -> vec2<i32> { return ((v % P) + P) % P; }
```

Requirements: `P` must be an **integer** number of lattice cells, and when you build fBm with lacunarity 2
the period must double per octave: octave *i* uses `P_i = P₀ * 2^i` (equivalently `P₀ * lacunarity^i`,
which forces lacunarity to be an integer — use exactly 2.0 for tileable fBm). Worley (§1.5) tiles by the
same rule (wrap the cell index). Simplex/OpenSimplex2 **cannot** be tiled this way (the lattice is skewed);
if you need tiling, use Perlin or value noise, or tile a 4D torus embedding
(`p → (cos u, sin u, cos v, sin v)` sampled with 4D noise) at ~2.5× cost.

### 1.4 Simplex / OpenSimplex2

**Simplex noise** (Perlin 2001) replaces the hypercube lattice with a simplex (triangle in 2D) lattice:
2D skew `F2 = (√3−1)/2 ≈ 0.3660254`, unskew `G2 = (3−√3)/6 ≈ 0.2113249`. Contributions use a radial
falloff `max(0, r² − |d|²)⁴ · dot(g, d)` with `r² = 0.5`, scaled by ≈ **70.0** in 2D to land in `[-1,1]`.
Cost: 3 gradient lookups in 2D vs 4 for Perlin; 4 vs 8 in 3D — the win grows with dimension.
**Patent note:** Perlin's *3D+ simplex* patent (US 6,867,776) expired 2022-01-18, so simplex is now
unencumbered; that patent is the historical reason OpenSimplex exists.

**OpenSimplex2** ([github.com/KdotJPG/OpenSimplex2](https://github.com/KdotJPG/OpenSimplex2), CC0/Unlicense)
is the modern recommendation. Two variants:

* **OpenSimplex2 (F, "Fast")** — resembles classic simplex; 3D uses "a rotated body-centered-cubic grid as
  the offset union of two rotated cubic grids"; 4D uses "5 offset copies of the dual (reverse-skewed) grid".
* **OpenSimplex2S ("Smooth")** — larger vertex contribution radius (4 nearest points per grid in 3D),
  smoother, **recommended for ridged noise** because the F variant's sharper kernel creates visible
  creases when you take `1−|n|`.

Both ship improved 24-direction 2D gradient tables for probability symmetry. Files are per-language
(`java/`, `csharp/`, `rust/`, plus a C FFI header at `rust/OpenSimplex2.h`); porting `OpenSimplex2S.java`'s
`noise2_ImproveX` to WGSL is mechanical (it is branch-light and table-driven; the 4D LUT is
`4×4×4×4` so keep it in a uniform/storage array, not `const` — WGSL const arrays of 256 vec4 blow up
shader compile times on some drivers).

**Domain rotation trick (important for terrain).** Sampling 3D noise on the plane `z=const` gives
axis-aligned artifacts. OpenSimplex2 exposes `noise3_ImproveXY` / `noise3_XZBeforeY`, which rotate the
lattice so the sampled plane is not lattice-aligned. If you animate/erode over a "time" axis, use these.
Equivalent DIY: rotate by `R = [[2/3,-1/3,-1/3],[-1/3,2/3,-1/3],[-1/3,-1/3,2/3]] + 1/3` — i.e. make the
sample plane orthogonal to `(1,1,1)`.

**When to use what**

| Basis | Cost (rel.) | Derivatives | Tileable | Artifacts | Use for |
|---|---|---|---|---|---|
| value | 1.0 | trivial, exact | yes | blocky, axis-aligned | detail, warp source |
| Perlin | 1.6 | exact (above) | yes | mild axis bias, `0` at lattice pts | primary terrain, warps |
| simplex/OS2 | 1.3 (2D), 0.6 (3D) | analytic possible but fiddly | no | triangular "pincushion" at high gain | primary terrain, 3D/4D |
| Worley F1 | 3–9 (3×3 or 5×5 loop) | finite-diff only | yes | grid-locked cells at low jitter | cracks, cells, plateaus |

### 1.5 Worley / cellular (F1, F2, F2−F1)

Steven Worley, *"A Cellular Texture Basis Function"*, SIGGRAPH 1996. One feature point per grid cell
(jittered), scan the 3×3 neighbourhood, keep the two smallest distances.

```wgsl
struct Worley { f1: f32, f2: f32, id1: u32, off1: vec2<f32> };

fn worley2D(x: vec2<f32>, seed: u32, jitter: f32) -> Worley {
  let ip = vec2<i32>(floor(x));
  let fp = fract(x);
  var f1 = 1e9; var f2 = 1e9; var id1 = 0u; var o1 = vec2<f32>(0.0);
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let g  = vec2<i32>(i, j);
      let hh = hash2(ip + g, seed);
      // two independent 16-bit fields -> feature point offset in [0,1)^2
      let o  = vec2<f32>(f32(hh & 0xFFFFu), f32((hh >> 16u) & 0xFFFFu)) * (1.0/65535.0);
      let r  = vec2<f32>(g) + (vec2<f32>(0.5) + jitter * (o - vec2<f32>(0.5))) - fp;
      let d  = dot(r, r);                  // squared distance; sqrt once at the end
      if (d < f1) { f2 = f1; f1 = d; id1 = hh; o1 = r; }
      else if (d < f2) { f2 = d; }
    }
  }
  return Worley(sqrt(f1), sqrt(f2), id1, o1);
}
```

* **`jitter`** ∈ [0,1], default **1.0**. Below ~0.6 the cells visibly snap to the grid. At `jitter = 1.0`
  the 3×3 scan is *not* strictly correct (a point in a cell 2 away can be closer); the error rate is
  < 0.1 % of pixels and is invisible in terrain. For correctness-critical use, scan 5×5 (2.8× cost) or
  clamp `jitter ≤ 0.5` where 3×3 is provably exact.
* **F1** → `1 − F1` gives round hills / "bubble" terrain; `F1` alone gives craters.
* **F2 − F1** → the classic **crack / ridge network**. It is 0 exactly on the Voronoi edges, so
  `1 − smoothstep(0, w, F2−F1)` is a clean river/canyon mask, and `pow(F2−F1, 0.5)` widens the walls.
* **F2** alone is rarely useful except as `F2/F1` (a scale-invariant edge measure).
* **id1** (the winning cell's hash) gives you a free per-cell random for "plateau at random height"
  (see §7, terracing by region).
* **Distance metrics:** Euclidean (above), Manhattan `abs(r.x)+abs(r.y)` (blocky, good for mesas),
  Chebyshev `max(abs(r.x),abs(r.y))` (rectangular plates), Minkowski `pow(|x|^p+|y|^p, 1/p)`.
* **Derivatives:** `F2−F1` is C⁰ but not C¹ (it creases at Voronoi vertices). Do **not** feed it to a
  derivative-aware fBm. Use central differences if you need a gradient, and expect the creases in
  curvature maps.
* **Tileable:** wrap `ip + g` with `mod_p` exactly as in §1.3.

### 1.6 Combining octaves: the six classic operators

All share this skeleton (`H` = Hurst exponent, `gain = 2^(-H)`, `lacunarity` = frequency ratio):

```
amplitude a = 1 ; frequency f = 1 ; sum = 0
for i in 0..octaves-1:
    sum += a * BASIS(p * f)
    f *= lacunarity          # typical 2.0, or 1.98/2.01 to break lattice alignment
    a *= gain                # typical 0.5
```

**Standard parameter ranges**

| Param | Range | Default | Effect |
|---|---|---|---|
| `octaves` | 1–16 | 8 (for N=1024) | see Nyquist rule below |
| `lacunarity` | 1.7–2.5 | 2.0 (1.98 to decorrelate) | > 2.5 shows octave separation as "rings" |
| `gain` (= 2^−H) | 0.35–0.65 | 0.5 (H = 1) | 0.5 ≈ real mountains; > 0.6 = noisy/alien; < 0.4 = smooth blobs |
| `H` (Hurst) | 0.6–1.2 | 0.9–1.0 | IQ measured real mountain profiles to sit near H ≈ 1 ([iquilezles.org/articles/fbm](https://iquilezles.org/articles/fbm/)) |

**Nyquist rule (stop adding octaves):** for a grid of `N` cells covering `F` base periods, the highest
useful octave is `i_max = floor(log2(N / (2·F·lacunarity⁰)))`. With `N = 1024` and base frequency 4
periods across the map: `i_max = log2(1024/8) = 7`, so **8 octaves** — anything beyond aliases into noise
and costs you erosion stability (steep 1-pixel spikes make the pipe model blow up).

#### (a) fBm — fractional Brownian motion
```wgsl
sum += a * n;                                   // n = basis in [-1,1]
```
Symmetric hills and valleys. This is your default base layer.

#### (b) Turbulence (Perlin 1985)
```wgsl
sum += a * abs(n);                              // in [0,1], creases at n=0
```
Gives sharp V-creases everywhere; use as a *modulator*, not a heightfield (it is C⁰ only).

#### (c) Billow
```wgsl
sum += a * (2.0 * abs(n) - 1.0);                // "turbulence remapped to [-1,1]"
```
Puffy, cloud-like, rounded bottoms. Good for dunes and rolling hills; invert (`-billow`) for pockmarks.

#### (d) Ridged multifractal (Musgrave)
The important one for mountains. Quoted from Musgrave's `RidgedMultifractal()` in
*Texturing & Modeling: A Procedural Approach*, 3rd ed., ch. 16 **[quoted, structure]**:

```wgsl
fn ridgedMF(p0: vec2<f32>, seed: u32, octaves: i32,
            H: f32, lacunarity: f32, offset: f32, gain: f32) -> f32 {
  var p = p0;
  var signal = offset - abs(perlin2D(p, seed).x);
  signal = signal * signal;                       // square: sharpens the ridge
  var result = signal;
  var weight = 1.0;
  var freqExp = 1.0;
  for (var i = 1; i < octaves; i = i + 1) {
    p = p * lacunarity;
    freqExp = freqExp * pow(lacunarity, -H);      // = exponent_array[i]
    weight = clamp(signal * gain, 0.0, 1.0);      // <-- feedback: detail only on ridges
    signal = offset - abs(perlin2D(p, seed + u32(i)*0x9E3779B1u).x);
    signal = signal * signal;
    signal = signal * weight;
    result = result + signal * freqExp;
  }
  return result;
}
```

| Param | Range | Default | Effect |
|---|---|---|---|
| `H` | 0.8–1.2 | **1.0** | roughness |
| `lacunarity` | 2.0–2.5 | **2.0** | |
| `offset` | 0.7–1.2 | **1.0** | < 1 sinks the valleys below 0 and flattens ridge tops; 1.0 is canonical |
| `gain` | 1.5–3.0 | **2.0** | the multiplicative feedback strength; > 3 makes ridges knife-thin |
| `octaves` | 6–10 | **8** | |

The `weight = signal * gain` feedback is what makes it a *multi*fractal: high-frequency detail only
appears where the previous octave was already near a ridge crest. That is exactly the statistical
signature of real mountain ranges (smooth valleys, detailed crests).

#### (e) Hybrid multifractal (Musgrave)
Amplitude depends on local altitude — high ground is rough, lowland is smooth. Great for
"mountains rising from plains" without a separate mask.

```wgsl
fn hybridMF(p0: vec2<f32>, seed: u32, octaves: i32,
            H: f32, lacunarity: f32, offset: f32) -> f32 {
  var p = p0;
  var freqExp = 1.0;
  var result = (perlin2D(p, seed).x + offset) * freqExp;
  var weight = result;
  p = p * lacunarity;
  for (var i = 1; i < octaves; i = i + 1) {
    weight = min(weight, 1.0);
    freqExp = freqExp * pow(lacunarity, -H);
    let signal = (perlin2D(p, seed + u32(i)*0x9E3779B1u).x + offset) * freqExp;
    result = result + weight * signal;
    weight = weight * signal;
    p = p * lacunarity;
  }
  return result;
}
```
Defaults: `H = 0.25`, `lacunarity = 2.0`, `offset = 0.7`, `octaves = 8`.
**Pitfall:** `weight *= signal` is an unbounded product — without the `min(weight, 1.0)` clamp it
explodes to `inf` in ~12 octaves. Also `offset` must keep `noise+offset > 0` most of the time or
`result` goes negative and the feedback sign flips (visually: shredded terrain).

#### (f) Combination cheat-sheet
```
ridged(p) * saturate(fbm_mask(p*0.3))            # mountain belts on a plain
mix(billow(p), ridged(p), saturate(fbm(p*0.2)))  # dunes blending into ranges
fbm(p) + 0.25 * ridged(p*4)                      # base relief + crest detail
```

### 1.7 Derivative-aware / "erosive" fBm

These fake the *look* of erosion for ~1/50th the cost of a real sim. They are the single best
quality-per-millisecond trick in the whole document. All of them require a basis that returns
`(value, ∂/∂x, ∂/∂y)`.

#### (a) IQ's derivative-damped fBm ("terrain")
Verbatim from [iquilezles.org/articles/morenoise](https://iquilezles.org/articles/morenoise/) **[quoted]**:

```glsl
float terrain( in vec2 p ) {
    float a = 0.0;
    float b = 1.0;
    vec2  d = vec2(0.0,0.0);
    for( int i=0; i<15; i++ ) {
        vec3 n = noised(p);
        d += n.yz;
        a += b*n.x/(1.0+dot(d,d));   // <-- amplitude killed where the slope is already large
        b *= 0.5;
        p = m*p*2.0;                 // m = rotation matrix, breaks lattice alignment
    }
    return a;
}
```

The `1/(1+dot(d,d))` term suppresses new detail on already-steep ground → smooth valley floors,
detailed flat-ish plateaus, and natural-looking "worn" slopes. **This is 3 lines and transforms
plain fBm into something that reads as eroded.** Use a 2×2 rotation `m = mat2(0.8,-0.6,0.6,0.8)`
between octaves to kill the axis-aligned lattice stacking.

The matching 3D fBm that also *returns* the accumulated derivative (needed for warping) is:

```glsl
vec4 fbm( in vec3 x, in int octaves ) {   // returns (value, dx, dy, dz)
    float f = 1.98;  float s = 0.49;
    float a = 0.0;   float b = 0.5;
    vec3  d = vec3(0.0);
    mat3  m = mat3(1,0,0, 0,1,0, 0,0,1);
    for( int i=0; i<octaves; i++ ) {
        vec4 n = noised(x);
        a += b*n.x;
        d += b*m*n.yzw;        // chain rule: accumulate derivative through the frequency transform
        b *= s;
        x = f*m3*x;
        m = f*m3i*m;
    }
    return vec4( a, d );
}
```
The `m`/`m3i` bookkeeping is the chain rule: since `x_{i+1} = f·M·x_i`, `∂/∂x_0 = f·Mᵀ·∂/∂x_i`.
If you skip it your derivatives are wrong by a rotation and the warp goes sideways.

#### (b) Swiss turbulence (Giliam de Carpentier)
Source: [decarpentier.nl/scape-procedural-extensions](http://www.decarpentier.nl/scape-procedural-extensions)
(the "Scape" terrain editor) **[quoted signature and semantics]**:

```
float swissTurbulence(float2 p, float seed, int octaves,
                      float lacunarity = 2.0, float gain = 0.5, float warp = 0.15)
```

```wgsl
fn swissTurbulence(p0: vec2<f32>, seed: u32, octaves: i32,
                   lacunarity: f32, gain: f32, warp: f32) -> f32 {
  var sum = 0.0;
  var freq = 1.0;
  var amp = 1.0;
  var dsum = vec2<f32>(0.0);
  for (var i = 0; i < octaves; i = i + 1) {
    // sample the octave at a point pushed toward the nearest ridge by the accumulated gradient
    let n = perlin2D((p0 + warp * dsum) * freq, seed + u32(i)*0x9E3779B1u);
    sum  = sum  + amp * (1.0 - abs(n.x));           // ridged
    dsum = dsum + amp * n.yz * (-n.x);              // d/dp of (1-|n|) up to sign
    freq = freq * lacunarity;
    amp  = amp * gain * clamp(sum, 0.0, 1.0);       // <-- altitude feedback (like hybrid MF)
  }
  return sum;
}
```

What it buys you: the `p + warp*dsum` offset **elongates slopes toward the nearest ridge**, producing the
characteristic parallel gully striping of water-carved mountainsides; the `amp *= gain*saturate(sum)`
kills fine detail in valleys (where sum is small) and keeps it on peaks. Defaults `lacunarity 2.0`,
`gain 0.5`, `warp 0.15` (raise `warp` to 0.3 for dramatic striping; above ~0.5 it self-intersects and
looks smeared).

#### (c) Jordan turbulence (Giliam de Carpentier)
Same source **[quoted signature]**:

```
float jordanTurbulence(float2 p, float seed, int octaves, float lacunarity = 2.0,
                       float gain1 = 0.8, float gain = 0.5,
                       float warp0 = 0.4, float warp = 0.35,
                       float damp0 = 1.0, float damp = 0.8, float damp_scale = 1.0)
```

```wgsl
fn jordanTurbulence(p0: vec2<f32>, seed: u32, octaves: i32,
                    lacunarity: f32, gain1: f32, gain: f32,
                    warp0: f32, warp: f32,
                    damp0: f32, damp: f32, damp_scale: f32) -> f32 {
  var n  = perlin2D(p0, seed);
  var n2 = n * n.x;                                  // square for a billowy profile
  var sum = n2.x;
  var dsum_warp = warp0 * vec2<f32>(n2.y, n2.z);
  var dsum_damp = damp0 * vec2<f32>(n2.y, n2.z);
  var amp = gain1;
  var freq = lacunarity;
  var damped_amp = amp * gain;
  for (var i = 1; i < octaves; i = i + 1) {
    n  = perlin2D(p0 * freq + dsum_warp, seed + u32(i)*0x9E3779B1u);
    n2 = n * n.x;
    sum = sum + damped_amp * n2.x;
    dsum_warp = dsum_warp + warp * vec2<f32>(n2.y, n2.z);
    dsum_damp = dsum_damp + damp * vec2<f32>(n2.y, n2.z);
    freq = freq * lacunarity;
    amp  = amp * gain;
    // "thermal-erosion-like" damping: flat regions lose fine detail, independent of elevation
    damped_amp = amp * (1.0 - damp_scale / (1.0 + dot(dsum_damp, dsum_damp)));
  }
  return sum;
}
```

Jordan maintains **two** accumulators: `dsum_warp` (horizontal stretching, same idea as swiss) and
`dsum_damp` (amplitude damping). The damping term
`damped_amp = amp * (1 - damp_scale/(1+dot(dsum_damp,dsum_damp)))` **[quoted]** mimics thermal erosion:
fine detail fades on *flat* regions regardless of altitude — unlike hybrid multifractal, which ties
detail to altitude. Result: smooth valley floors + crisp ridges, without a sim.

**Attribution note:** these two are frequently miscredited to Inigo Quilez. Swiss and Jordan turbulence
are **Giliam de Carpentier's** (Scape, 2011); IQ's contribution is the derivative-damped fBm in (a) and
the analytic-derivative noise bases.

#### (d) Comparison
| Variant | Cost vs plain fBm | Signature look | Feeds real erosion well? |
|---|---|---|---|
| IQ damped fBm | 1.0× (derivs are free with quintic) | worn, rounded, no hard creases | yes — very stable input |
| Swiss | 1.05× | parallel gullies down slopes | yes |
| Jordan | 1.15× | billowy peaks, flat valley floors | yes |
| ridged MF | 1.0× | knife ridges | **no** — 1-px spikes destabilize the pipe model; pre-smooth or lower `gain` |

### 1.8 Domain warping

`f(p) = fbm(p + A·fbm(p + B·fbm(p)))`. From [iquilezles.org/articles/warp](https://iquilezles.org/articles/warp/) **[quoted]**:

```glsl
// single warp
float pattern( in vec2 p ) {
    vec2 q = vec2( fbm( p + vec2(0.0,0.0) ), fbm( p + vec2(5.2,1.3) ) );
    return fbm( p + 4.0*q );
}
// recursive (double) warp
float pattern( in vec2 p ) {
    vec2 q = vec2( fbm( p + vec2(0.0,0.0) ), fbm( p + vec2(5.2,1.3) ) );
    vec2 r = vec2( fbm( p + 4.0*q + vec2(1.7,9.2) ),
                   fbm( p + 4.0*q + vec2(8.3,2.8) ) );
    return fbm( p + 4.0*r );
}
```

* The offsets `(5.2,1.3)`, `(1.7,9.2)`, `(8.3,2.8)` are arbitrary decorrelators. **Prefer distinct
  seeds over domain offsets** on GPU: `fbm(p, seed+1)` is both cheaper and precision-safe (§1.9).
* **Warp amplitude `A`:** `0.1–0.5` = subtle organic wobble; `1.0–4.0` = strong swirls (IQ uses 4.0
  because his fbm is in `[-1,1]` and the domain is O(1) — scale `A` to your domain: a good rule is
  `A ≈ 0.3 × (base wavelength)`).
* **Cost:** single warp = 3× fbm, double warp = 7× fbm. Budget accordingly: at 2048² with 8 octaves,
  a double warp is ~7 × 4.2 M × 8 ≈ 235 M noise evals ≈ 30–80 ms on a mid GPU.
* **Warp-by-derivative (free warp):** if your fbm already returns `d`, then `p' = p + A·vec2(d.y,-d.x)`
  (the perpendicular of the gradient) shears the field along contour lines and costs nothing extra.
  This produces beautifully sheared strata / fold-mountain patterns.
* **Warping breaks tileability** unless the warp source has the same period; if you need tiling,
  make every fbm in the chain use the same `P` (and hence the same lacunarity 2.0).

### 1.9 Seeding, tiling, and precision recipes

1. **Seed by hash, not by offset.** `noise(p + vec2(seed*1000.0))` loses precision: at `p ≈ 1e6`,
   f32 spacing is `0.0625`, so a 512-cell noise lattice quantizes to 8 distinct positions per cell → visible
   staircase. Always fold the seed into the integer hash.
2. **Tileable fBm** (period `P₀` lattice cells, lacunarity exactly 2):
   octave `i` wraps its lattice at `P_i = P₀ << i`. Verify by sampling `f(x)` and `f(x + P₀)` — they must
   be bit-identical.
3. **Erosion-friendly**: clamp the input to erosion so that `max|∇h| · cellSize` stays below ~1.0
   (i.e. slopes under 45°). One cheap pre-pass: 3 iterations of a 3×3 box blur on the top octave only,
   or simply drop the last octave. This is the difference between a pipe sim that converges and one that
   NaNs in 200 steps.
4. **Precompute to a texture.** Noise is pure; evaluate once into an `r32float` storage texture/buffer and
   never re-evaluate it inside erosion loops.

### 1.10 Performance reference (measured order of magnitude, 2048² = 4.19 M cells, mid-range dGPU)

| Operation | ms |
|---|---|
| Perlin fBm, 8 octaves, with derivatives | 3–6 |
| Swiss/Jordan, 8 octaves | 4–8 |
| double domain warp, 8 octaves | 25–50 |
| Worley F1/F2, 3×3, 1 octave | 2–4 |
| one pipe-model erosion iteration (7 passes) | 1.5–3 |
| one droplet batch (100 k droplets × 30 steps) | 4–10 |

---

## 2. Hydraulic erosion

Two families. They produce genuinely different results and have different scaling behaviour.
Read §2.3 before choosing.

---

### 2.1 Grid / virtual-pipe model (Mei, Decaudin, Hu 2007)

**Primary source:** Xing Mei, Philippe Decaudin, Bao-Gang Hu, *"Fast Hydraulic Erosion Simulation and
Visualization on GPU"*, Pacific Graphics 2007.
PDF: <http://evasion.inrialpes.fr/Publications/2007/MDH07/FastErosion_PG07.pdf> (§3, equations 1–15).
Pipe model originally from O'Brien & Hodgins, *"Dynamic Simulation of Splashing Fluids"*, CA'95.
The practical GPU extension used below (depth-limited capacity, hardness, water-conserving
erosion/deposition, pipe-based thermal) is Balázs Jákó, *"Fast Hydraulic and Thermal Erosion on the GPU"*,
CESCG 2011: <https://old.cescg.org/CESCG-2011/papers/TUBudapest-Jako-Balazs.pdf> (equations 2–18, Table 2).

#### State (per cell)
`b` terrain height, `d` water height, `s` suspended sediment, `f = (fL,fR,fT,fB)` outflow flux,
`v = (u,v)` velocity. Mei §3 **[quoted]**.

#### Step 1 — water increment (Mei eq. 1) **[quoted]**
```
d1(x,y) = dt(x,y) + Δt · rt(x,y)
```
`rt` = water arriving per unit time (rain: uniform or a noise mask; sources: a few cells with large `r`).

#### Step 2a — outflow flux (Mei eq. 2–3) **[quoted]**
```
fL_{t+Δt}(x,y) = max( 0 , fL_t(x,y) + Δt · A · g · ΔhL(x,y) / l )

ΔhL_t(x,y) = bt(x,y) + d1(x,y) − bt(x−1,y) − d1(x−1,y)
```
`A` = virtual pipe cross-sectional area, `g` = gravity, `l` = pipe length. `fR, fT, fB` analogous.
The `max(0, …)` means pipes are one-directional (outflow only) — inflow arrives as a neighbour's outflow.

#### Step 2b — flux scaling (Mei eq. 4–5) **[quoted]**
```
K = min( 1 , d1 · lX · lY / ( (fL + fR + fT + fB) · Δt ) )
f^i_{t+Δt}(x,y) = K · f^i_{t+Δt}(x,y) ,   i = L,R,T,B
```
This is what makes the scheme unconditionally non-negative in water: you can never drain more than the
cell holds.

> **GOTCHA:** Jákó's CESCG paper reprints this as `K = max(1, …)` (his eq. 4). That is a **typo**; `max`
> makes `K ≥ 1`, which *amplifies* the flux and blows up instantly. Use `min`, as in Mei eq. (4).

#### Step 2c — water height update (Mei eq. 6–7) **[quoted]**
```
ΔV(x,y) = Δt · ( fR_{t+Δt}(x−1,y) + fT_{t+Δt}(x,y−1)
                + fL_{t+Δt}(x+1,y) + fB_{t+Δt}(x,y+1)
                − Σ_{i∈{L,R,T,B}} f^i_{t+Δt}(x,y) )

d2(x,y) = d1(x,y) + ΔV(x,y) / (lX · lY)
```

#### Step 2d — velocity field (Mei eq. 8–9) **[quoted]**
```
ΔWX = [ fR(x−1,y) − fL(x,y) + fR(x,y) − fL(x+1,y) ] / 2
lY · d̄ · u = ΔWX ,      d̄ = (d1 + d2)/2
```
so `u = ΔWX / (lY · d̄)` and `v` analogously with `ΔWY / (lX · d̄)`.

> **GOTCHA (division by zero):** `d̄ → 0` on dry cells makes `u → ∞`. Guard:
> `u = ΔWX / (lY * max(d̄, dEps))` with `dEps ≈ 1e-4` (in normalized units), and additionally clamp
> `|v| ≤ vMax` (e.g. `lX/Δt`, the CFL speed). Without this the first dry frame produces `inf`, which
> propagates through the semi-Lagrangian advection and NaNs the whole map in one step.

#### Step 3 — erosion / deposition (Mei eq. 10–12) **[quoted]**
```
C(x,y) = Kc · sin(α(x,y)) · |v(x,y)|                                  (10)

if C > st :   b_{t+Δt} = bt − Ks(C − st)        s1 = st + Ks(C − st)  (11a,11b)
if C ≤ st :   b_{t+Δt} = bt + Kd(st − C)        s1 = st − Kd(st − C)  (12a,12b)
```
`Kc` sediment capacity constant, `Ks` dissolving constant, `Kd` deposition constant,
`α` = local tilt angle.

**Closed form for `sin α`** **[derived]** — you need it and the paper doesn't give it:
```wgsl
let gx = (b(x+1,y) - b(x-1,y)) / (2.0*lX);
let gy = (b(x,y+1) - b(x,y-1)) / (2.0*lY);
let g2 = gx*gx + gy*gy;
let sinAlpha = sqrt(g2 / (1.0 + g2));     // = |∇b| / sqrt(1+|∇b|²) = sin(atan|∇b|)
let sinAlphaClamped = max(sinAlpha, minTilt);   // Mei §3.3 explicitly recommends a floor
```
Mei §3.3 **[quoted]**: *"for very flat terrains where the α value approaches zero, C will be very small
… This problem can be alleviated by limiting the α value with a user-specified minimum threshold."*
Use `minTilt ∈ [0.01, 0.1]`, default **0.05**.

> **GOTCHA:** Jákó's eq. (9) prints `C = Kc · sin(α(x,y)|v(x,y)|)` — the parenthesis is misplaced.
> It is `Kc · sin(α) · |v|`, as in Mei eq. (10).

**Jákó's three improvements — take all of them, they each fix a real artifact:**

1. **Depth-limited erosion** (Jákó eq. 10) **[quoted]**:
```
C(x,y) = Kc · sin(α) · |v| · lmax(d1(x,y))

lmax(x) = 0                                  , x ≤ 0
        = 1 - (Kdmax - x)/Kdmax              , 0 < x < Kdmax
        = 1                                  , x ≥ Kdmax
```
Wait — read the ramp direction carefully: as written it *increases* with depth. In Jákó's intent
(stated in the text: *"the erosion will occur only in shallower areas, forcing the simulation to dispose
sediment at deeper water areas"*) you want the **inverse ramp**. Implement the behaviour, not the typo:
```wgsl
fn lmax(depth: f32, Kdmax: f32) -> f32 {   // 1 at the surface, 0 below Kdmax
  return clamp(1.0 - depth / Kdmax, 0.0, 1.0);
}
```
This is what stops rivers from cutting absurdly deep trenches and gives you believable lake/sea floors.

2. **Water-conserving erosion** (Jákó eq. 12c/13c) **[quoted]**:
```
erosion : b -= Δt·R·Ks(C−s) ; s += Δt·R·Ks(C−s) ; d += Δt·R·Ks(C−s)
deposit : b += Δt·Kd(s−C)   ; s -= Δt·Kd(s−C)   ; d -= Δt·Kd(s−C)
```
Jákó: *"Originally, the Δt·Kd(st−C) suspended sediment amount was subtracted from the terrain height bt
without adding it to dt water height… caused water to disappear with the sediment… causes regular
ripples on the water surface in the long run."* **[quoted]** — adding the volume to `d` removes a
long-period oscillation. Clamp the dissolved amount to `d` so `d` never goes negative.

3. **Sediment softening / hardness feedback** (Jákó eq. 14) **[quoted]**:
```
R_{t+Δt}(x,y) = max( Rmin , R_t(x,y) − Δt · Kh · Ks (st − C) )
```
Deposited material becomes softer over time → re-eroded preferentially → braided channels and realistic
floodplains. `Rmin ≈ 0.1`.

#### Step 4 — sediment transport (Mei eq. 13–14) **[quoted]**
```
∂s/∂t + (v · ∇s) = 0                                       (13)
s_{t+Δt}(x,y) = s1( x − u·Δt , y − v·Δt )                  (14)
```
Semi-Lagrangian backtrace (Stam 1999); bilinear-interpolate the four nearest cells. Mei:
*"Since the semi-Lagrangian approach is unconditionally stable, there will be no stability problem for
this step."* **[quoted]**

> Semi-Lagrangian is stable but **diffusive** — sediment smears out over ~1 cell per step. For sharper
> rivers use MacCormack/BFECC (advect forward, then backward, correct by half the error): 3× the cost,
> visibly crisper channels. Clamp the corrected value to the min/max of the 4 source cells or it
> overshoots and rings.

#### Step 5 — evaporation (Mei eq. 15) **[quoted]**
```
d_{t+Δt}(x,y) = d2(x,y) · (1 − Ke · Δt)
```

#### Summary (Mei §3.5) **[quoted]**
```
1. d1        ← WaterIncrement(dt)
2. (d2, f_{t+Δt}, v_{t+Δt}) ← FlowSimulation(d1, bt, ft)
3. (b_{t+Δt}, s1)           ← ErosionDeposition(v_{t+Δt}, bt, st)
4. s_{t+Δt}  ← SedimentTransport(s1, v_{t+Δt})
5. d_{t+Δt}  ← Evaporation(d2)
```
Mei §4 **[quoted]**: implemented as **7 GPU passes** (steps 1,3,4,5 = 1 pass each; step 2 = 3 passes:
flux → water height → velocity).

#### Stability and time step

Mei §3.2.2 **[quoted]**: *"this limitation can be approximately expressed with the CFL condition:
Δt·u ≤ lX, Δt·v ≤ lY. When the size of the grid increases (lX, lY decrease), we should decrease the time
step proportionally."*

That is the *advection* CFL. There is a second, usually tighter, constraint from the pressure/flux
coupling, which the paper does not state. **[derived]**: the pipe model in 1D is
`∂f/∂t = (A g / l)·∂h/∂x·l` and `∂d/∂t = −(1/l²)·∂f/∂x`, giving the wave equation
`∂²d/∂t² = (A g / l)·∂²d/∂x²`, i.e. a gravity-wave speed

```
c = sqrt( A · g / l )
Δt ≤ l / c = sqrt( l³ / (A · g) )              [derived]
```

Use a safety factor: `Δt = 0.5 · sqrt(l³/(A·g))`.
*Sanity check against Jákó's Table 2:* `A = 20`, `g = 9.81`, `l = 1` → bound `= 0.0714`; his stated
allowed range is `Δt ∈ [0, 0.05]` with default `0.02`. Consistent.
*Sanity check against Mei's Table 1:* Δt = 0.002 (256²), 0.001 (512²), 0.0005 (1024²), 0.00025 (2048²),
0.000125 (4096²) — he scales `Δt ∝ 1/N`, i.e. `∝ l`, which is *conservative* relative to `l^{3/2}`.

**Practical rule:** fix `l = lX = lY = 1.0` in simulation units and change `A` instead of `Δt` when you
change resolution. Then one parameter set works at every N.

#### Parameter table (Jákó Table 2 **[quoted]**, plus Mei-only entries)

| Symbol | Description | Range | Default |
|---|---|---|---|
| `Δt` | time increment | [0, 0.05] | **0.02** |
| `Kr` | rain rate | [0, 0.05] | **0.012** |
| `Ke` | evaporation rate | [0, 0.05] | **0.015** |
| `A` | virtual pipe cross-section area | [0.1, 60] | **20** |
| `g` | gravity | [0.1, 20] | **9.81** |
| `Kc` | sediment capacity | [0.1, 3] | **1** |
| `Ks` | soil suspension (dissolving) rate | [0.1, 2] | **0.5** |
| `Kd` | sediment deposition rate | [0.1, 3] | **1** |
| `Kh` | sediment softening rate | [0, 10] | **5** |
| `Kdmax` | maximal erosion depth | [0, 40] | **10** |
| `Ka` | talus-angle tangent coefficient (thermal) | [0, 1] | **0.8** |
| `Ki` | talus-angle tangent bias (thermal) | [0, 1] | **0.1** |
| `Kt` | thermal erosion rate | [0, 3] | **0.15** |
| `minTilt` | floor on sin α | [0.01, 0.1] | 0.05 (Mei §3.3, value mine) |
| `lX,lY,l` | grid spacing / pipe length | — | 1.0 |
| iterations | — | 200–2000 | ~1000 (Jákó's figures use 1000) |

#### Boundary conditions
Mei §3.2.1 **[quoted]**: *"we assume no water can flow out of the grid ('no slip')… For cells on the left
boundary, the outflow flux to the left neighbour fL should be set to zero."*
For terrain *generation* you usually want the opposite — **open boundaries** so water leaves the map and
doesn't pond at the rim. Implement by allowing the boundary outflow but discarding it (never adding it as
anyone's inflow). Add a flag: `closedBoundary: bool`.

#### WGSL skeleton (pass 2a: flux)

```wgsl
struct Params {
  N: u32, _p0: u32,
  dt: f32, A: f32, g: f32, l: f32, lX: f32, lY: f32,
  Kc: f32, Ks: f32, Kd: f32, Ke: f32, Kr: f32, Kdmax: f32, minTilt: f32, dEps: f32,
};
@group(0) @binding(0) var<uniform>                  P    : Params;
@group(0) @binding(1) var<storage, read>            b    : array<f32>;
@group(0) @binding(2) var<storage, read>            d1   : array<f32>;
@group(0) @binding(3) var<storage, read>            fIn  : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write>      fOut : array<vec4<f32>>;

fn ix(x: i32, y: i32) -> u32 {
  let n = i32(P.N);
  return u32(clamp(y,0,n-1) * n + clamp(x,0,n-1));      // clamp-to-edge
}

@compute @workgroup_size(8, 8)
fn fluxPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= n || y >= n) { return; }
  let i = u32(y*n + x);

  let h0 = b[i] + d1[i];
  let hL = b[ix(x-1,y)] + d1[ix(x-1,y)];
  let hR = b[ix(x+1,y)] + d1[ix(x+1,y)];
  let hT = b[ix(x,y-1)] + d1[ix(x,y-1)];
  let hB = b[ix(x,y+1)] + d1[ix(x,y+1)];

  let k = P.dt * P.A * P.g / P.l;
  var f = max(vec4<f32>(0.0),
              fIn[i] + k * vec4<f32>(h0-hL, h0-hR, h0-hT, h0-hB));

  // closed boundary: kill flux that would leave the grid
  if (x == 0)     { f.x = 0.0; }
  if (x == n-1)   { f.y = 0.0; }
  if (y == 0)     { f.z = 0.0; }
  if (y == n-1)   { f.w = 0.0; }

  let sum = f.x + f.y + f.z + f.w;
  let K = select(1.0,
                 min(1.0, d1[i] * P.lX * P.lY / (sum * P.dt)),
                 sum > 1e-12);
  fOut[i] = f * K;
}
```

Remaining passes are mechanical from the equations above. Total per iteration: 7 dispatches
(or 5 if you fuse water-height+velocity and erosion+deposition).

#### Pipe-model characteristics
* **Cost:** O(N²) per iteration, ~7 dispatches. At 2048² expect 1.5–3 ms/iteration.
* **Convergence:** visible channels after ~200 iterations; mature drainage networks at 1000–3000.
* **Strength:** produces *water*, so you get lakes, deltas, braided channels, correct deposition
  basins for free; it is a real (if simplified) shallow-water solver.
* **Weakness:** rivers are ~2–4 cells wide regardless of scale; at 4096²+ the visual channel density
  looks too fine unless you scale `A` and `Kc` up; memory-heavy (§0.3).

---

### 2.2 Particle / droplet erosion (Beyer 2015 → Lague 2019)

**Primary sources:**
* Hans Theobald Beyer, *"Implementation of a method for hydraulic erosion"*, BSc thesis, TU München 2015:
  <https://www.firespark.de/resources/downloads/implementation%20of%20a%20methode%20for%20hydraulic%20erosion.pdf>
* Sebastian Lague, `Hydraulic-Erosion`: <https://github.com/SebLague/Hydraulic-Erosion> —
  CPU: `Assets/Scripts/Erosion.cs`; GPU: `Assets/Scripts/ComputeShaders/Erosion.compute`.
* Predecessor blog (origin of the algorithm shape): <http://ranmantaru.com/blog/2011/10/08/water-erosion-on-heightmap-terrain/>

Each droplet is an independent agent: spawn at a random cell, roll downhill with inertia, pick up /
drop sediment, evaporate, die after `maxLifetime` steps. No water field — the "water" is a scalar
carried by the droplet.

#### The full algorithm, annotated (line refs to `Erosion.cs` @ master)

**Bilinear height + gradient** (`Erosion.cs:130–153`) **[quoted]**:
```csharp
float gradientX = (heightNE - heightNW) * (1 - y) + (heightSE - heightSW) * y;   // L146
float gradientY = (heightSW - heightNW) * (1 - x) + (heightSE - heightNE) * x;   // L147
float height = heightNW*(1-x)*(1-y) + heightNE*x*(1-y) + heightSW*(1-x)*y + heightSE*x*y;  // L150
```
This is the *exact* analytic gradient of the bilinear patch — not a finite difference. Using a central
difference instead produces visible 1-cell stair-stepping in the droplet paths.

**Direction with inertia** (`Erosion.cs:72–79`) **[quoted]**:
```csharp
dirX = (dirX * inertia - heightAndGradient.gradientX * (1 - inertia));
dirY = (dirY * inertia - heightAndGradient.gradientY * (1 - inertia));
len = sqrt(dirX*dirX + dirY*dirY);  if (len != 0) { dirX /= len; dirY /= len; }
posX += dirX;  posY += dirY;          // move exactly 1 cell per step, regardless of speed
```

**Termination** (`Erosion.cs:84–86`) **[quoted]**: stop if `dir == 0` or the droplet leaves
`[0, mapSize-1)`.

**Capacity** (`Erosion.cs:93`) **[quoted]**:
```csharp
float sedimentCapacity = Max(-deltaHeight * speed * water * sedimentCapacityFactor, minSedimentCapacity);
```
with `deltaHeight = newHeight - oldHeight` (negative downhill), so capacity ∝ drop × speed × water.

**Deposit / erode** (`Erosion.cs:96–121`) **[quoted]**:
```csharp
if (sediment > sedimentCapacity || deltaHeight > 0) {
    float amountToDeposit = (deltaHeight > 0)
        ? Min(deltaHeight, sediment)                       // uphill: fill the pit up to level
        : (sediment - sedimentCapacity) * depositSpeed;    // otherwise drop a fraction of the excess
    sediment -= amountToDeposit;
    // bilinear splat into the 4 corners of the CURRENT cell (no radius!)
    map[i]              += amountToDeposit * (1-u)*(1-v);
    map[i+1]            += amountToDeposit *   u  *(1-v);
    map[i+mapSize]      += amountToDeposit * (1-u)*  v;
    map[i+mapSize+1]    += amountToDeposit *   u  *  v;
} else {
    float amountToErode = Min((sedimentCapacity - sediment) * erodeSpeed, -deltaHeight);
    // erosion is spread over a radial BRUSH so it doesn't dig 1-pixel needles
    for (each brush node j) {
        float w = amountToErode * brushWeights[j];
        float delta = min(map[j], w);
        map[j] -= delta;  sediment += delta;
    }
}
```
Note the asymmetry, which Lague comments on directly (`Erosion.cs:102`) **[quoted]**:
*"Deposition is not distributed over a radius (like erosion) so that it can fill small pits."*

**Speed & water** (`Erosion.cs:124–125`) **[quoted]**:
```csharp
speed = Mathf.Sqrt (speed * speed + deltaHeight * gravity);
water *= (1 - evaporateSpeed);
```

> **TWO REAL BUGS TO FIX IN YOUR PORT.**
> 1. **Sign.** With `deltaHeight = new − old`, going downhill gives `deltaHeight < 0`, so
>    `speed² + deltaHeight·g` *decreases* speed on descent. Beyer's formulation uses the drop
>    `Δh = h_old − h_new > 0`. Use `speed = sqrt(max(0, speed*speed - deltaHeight*gravity))`.
> 2. **NaN.** Either sign, the radicand can go negative (steep uphill). The `max(0, …)` is mandatory;
>    without it a single NaN droplet writes NaN into the map and the NaN spreads through every
>    subsequent droplet that touches those cells. **Always clamp.**
> Also add a global `if (!isfinite(h)) h = 0;` scrub pass every few thousand droplets during development.

#### The erosion brush (`Erosion.cs:155–201`)

Offsets within radius `r` satisfying `x² + y² < r²`, weight `w = 1 − sqrt(x²+y²)/r`, normalized to sum 1
(`Erosion.cs:174–180, 198`) **[quoted]**. Exact counts **[derived]** (Gauss circle count minus the
boundary ring, since the test is strict `<`):

| radius | cells in brush |
|---|---|
| 2 | 9 |
| 3 | **25** |
| 4 | 45 |
| 5 | 69 |
| 8 | 193 |

**Cost warning:** brush cells are the inner loop. Radius 3 = 25 scattered read-modify-writes per erode
step; radius 8 = 193 → ~8× the cost. Stay at 2–4.

**Do NOT copy the per-cell brush precomputation.** `Erosion.cs:156–157` allocates
`int[mapSize*mapSize][]` + `float[mapSize*mapSize][]`. At 1024² with radius 3 that is
`1,048,576 × 25 × 8 B = 200 MiB` of jagged arrays. It works only because of the condition at
`Erosion.cs:169` — offsets are recomputed *only* near borders, and interior cells reuse the last
computed (translation-invariant) offset set. On GPU, store **one** offset array (25 `vec2<i32>` + 25 `f32`
= 300 bytes, put it in a uniform buffer) and clamp/skip at the borders. The compute version does exactly
this: `Erosion.compute:5–6` binds flat `brushIndices`/`brushWeights` plus a `borderSize` that keeps
droplets away from the edge.

#### Parameter list + defaults (`Erosion.cs:5–22` **[quoted]**)

| Field | Range | Default | Meaning / tuning |
|---|---|---|---|
| `seed` | any | 0 | |
| `erosionRadius` | 2–8 | **3** | brush radius; bigger = smoother, wider valleys, slower |
| `inertia` | 0–1 | **0.05** | 0 = instantly follows gradient (fractal, jittery paths); 1 = never turns. Above ~0.3 droplets overshoot ridges and carve unnatural straight lines |
| `sedimentCapacityFactor` | 1–10 | **4** | master erosion strength |
| `minSedimentCapacity` | 0–0.05 | **0.01** | keeps capacity non-zero on flats (same role as Mei's `minTilt`) |
| `erodeSpeed` | 0–1 | **0.3** | fraction of the capacity deficit removed per step |
| `depositSpeed` | 0–1 | **0.3** | fraction of the excess dropped per step |
| `evaporateSpeed` | 0–1 | **0.01** | water multiplier `(1-e)` per step; with lifetime 30 the droplet retains `0.99³⁰ = 0.74` of its water |
| `gravity` | 1–20 | **4** | scales speed growth |
| `maxDropletLifetime` | 10–64 | **30** | steps ≈ max path length in cells |
| `initialWaterVolume` | — | **1** | |
| `initialSpeed` | — | **1** | |
| `borderSize` (GPU) | ≥ erosionRadius+1 | 3–5 | droplets never spawn within this of the edge |

**Iteration count.** Lague's README uses **70 000 droplets** for a 255² map, i.e. ≈ **1.08 droplets per
cell**. Scale linearly with cell count:

```
numDroplets ≈ k · N²,   k ∈ [0.5, 4],  k = 1 is a good default
```
`N = 1024` → ~1 M droplets; `N = 4096` → ~17 M droplets. On GPU at 1024 droplets/workgroup-dispatch-slot
this is seconds, not minutes.

#### GPU implementation (this is the tricky part)

`Erosion.compute` (`[numthreads(1024,1,1)]`, `Erosion.compute:50`) runs **one droplet per invocation**
writing into a `RWStructuredBuffer<float> map`. That is a **data race**: two droplets touching the same
cell in the same dispatch produce non-deterministic, lost updates. It is tolerated because erosion is
statistically averaged. For a production tool you have three options:

1. **Accept the race** (fastest). Use a plain `array<f32>` with `read_write`. Results are
   non-deterministic across runs. Acceptable for art, unacceptable if you promise "same seed = same map".
2. **Fixed-point atomics** (deterministic, ~1.3× cost). Store the map as `array<atomic<i32>>` in
   fixed point: `q = i32(h * 2^20)` gives ~1e-6 height resolution over ±2048.
   ```wgsl
   fn addHeight(i: u32, dh: f32) { atomicAdd(&mapQ[i], i32(round(dh * 1048576.0))); }
   ```
   WGSL has **no float atomics** — `atomic<T>` requires `T` = `u32`|`i32`
   ([WGSL §6.4.5 Atomic Types](https://www.w3.org/TR/WGSL/#atomic-types)). Fixed point is the standard
   workaround; the CAS-loop alternative (`atomicCompareExchangeWeak` on bitcast `u32`) is ~3× slower
   under contention.
   Atomic *adds* are commutative, so the result is order-independent → **fully deterministic**.
3. **Batch + reduce** (deterministic, highest quality): run droplets in batches of ~`N²/32`, accumulate
   deltas into a separate `array<atomic<i32>>` delta buffer, then apply and clear. Reads within a batch
   see a consistent height field, which removes the "droplet follows a hole another droplet just dug"
   artifact.

**Spawn distribution.** `Erosion.compute:53` indexes a precomputed `randomIndices` buffer. Generate it on
CPU (a shuffled permutation → perfectly uniform coverage, no clumping) or on GPU from a
low-discrepancy sequence (`R2`: `p_i = frac(i * vec2(0.7548776662, 0.5698402910))`), which gives better
coverage than white noise for the same count.

#### Droplet-model characteristics
* **Cost:** O(droplets × lifetime × brushSize). 1 M droplets × 30 × 25 = 750 M scattered RMWs.
* **Memory:** just the heightfield. This is why it scales to 8192².
* **Strength:** crisp, dendritic, deeply-incised valleys; cheap; trivially parallel; excellent at
  "adding erosion detail to an existing shape".
* **Weakness:** no standing water → no lakes, no deltas, no sea floors; sediment deposition is less
  physically convincing; produces almost no wide floodplains; results depend on droplet count in a
  non-obvious way (double the droplets ≈ double the incision depth).

---

### 2.3 Which one, and when

| | Pipe / grid (Mei) | Droplet (Beyer/Lague) |
|---|---|---|
| Memory per cell | ~36–48 B (+ping-pong) | 4 B |
| Max practical N (single GPU pass) | 2048–4096 | 8192+ |
| Produces lakes / sea floor | **yes** | no |
| Produces deltas / alluvial deposits | **yes** | weak |
| Valley cross-section | U-ish, wide, wet | **V**, sharp, dendritic |
| Determinism | exact (pure gather) | needs atomics (§2.2) |
| Tunability | 13 coupled parameters, fragile | 11 parameters, forgiving |
| Time to "looks good" | 500–2000 iterations | 1× N² droplets |
| Failure mode | NaN/blow-up (CFL, `d̄→0`) | slow convergence, noisy pitting |

**Recommendation for large maps (≥ 4096²):**
run **droplet** erosion as the main pass (memory-cheap, scales), then a **short pipe-model pass**
(100–300 iterations at *half* resolution, upsampled) purely to generate water bodies, deposition basins
and the wetness map. You get dendritic incision plus plausible lakes without paying 1 GiB of state.

**Recommendation for ≤ 2048²:** pipe model end-to-end; it gives you `d` (water) and `s` (sediment)
fields that feed directly into the texturing maps of §6 (wetness, sediment colour) for free.

**Hybrid trick that works very well:** run the pipe model to convergence at 1024², upsample `b` with
bicubic to the target resolution, then run droplet erosion to re-sharpen the fine detail. The large-scale
drainage network comes from the physically-grounded solver; the sub-cell crispness comes from droplets.

---

## 3. Thermal erosion / talus

Thermal erosion (a.k.a. thermal weathering, slumping, diffusive erosion) moves material downhill wherever
the slope exceeds the **talus angle** (angle of repose). It is what turns knife-edge noise ridges into
believable scree slopes, and it is the cheapest realism-per-flop operation available.

### 3.1 Classic Musgrave (1989)

**Source:** F. K. Musgrave, C. E. Kolb, R. S. Mace, *"The Synthesis and Rendering of Eroded Fractal
Terrains"*, SIGGRAPH '89, pp. 41–50. Restated with exact formulas by Jacob Olsen, *"Realtime Procedural
Terrain Generation"*, IMADA/SDU 2004, <http://web.mit.edu/cesium/Public/terrain.pdf> §"Thermal erosion".

Definitions (Olsen p. 5) **[quoted]**: `d_i = h − h_i` for each neighbour (positive = neighbour is lower).

Move material to every neighbour whose `d_i` exceeds the talus threshold `T`, proportionally
(Olsen p. 5) **[quoted]**:
```
h_i = h_i + c · (d_max − T) · d_i / d_total
h   = h   − c · (d_max − T)
```
where `d_total = Σ d_i over all i with d_i > T`, and `d_max = max d_i`.

| Param | Range | Default | Notes |
|---|---|---|---|
| `T` (talus) | `tan(30°)·cellSize` … `tan(45°)·cellSize` | `4/N` in Musgrave's original normalization | in *height units per cell*; for a 0–1 height map on an N grid, `T = tan(θ)·(worldSize/N)/heightRange` |
| `c` | 0.3–0.6 | **0.5** | fraction of the maximum legal transfer actually moved; **must be ≤ 0.5** |
| neighbourhood | Moore (8) or von Neumann (4) | Moore for quality | |
| iterations | 10–200 | 50 | Olsen: "no more than 50 iterations … are needed to show the distinct effects" **[quoted]** |

**Why `c ≤ 0.5`:** if a cell gives away `(d_max − T)` in full, the *receiving* cell may now be higher than
the giver, and next iteration the material bounces back → a 2-cycle oscillation that never settles.
Jákó states the same limit explicitly (eq. 17 context) **[quoted]**: *"the volume to be moved is
ΔS = a·H/2. This is the maximum, otherwise the algorithm will oscillate."*

**Convergence.** It is a nonlinear diffusion; expect `O(L²)` iterations to relax a feature `L` cells
wide. To flatten a 100-cell-wide massif to the talus angle you need thousands of passes. Fix: run a
**multi-scale** schedule (§3.4).

### 3.2 Olsen's fast "slippage" variant

**Source:** Olsen 2004, §"Optimizations" **[quoted]**. Four changes:

1. **von Neumann (4) instead of Moore (8)** neighbourhood — halves the work. Olsen also found a
   **rotated** von Neumann (the 4 *diagonal* neighbours, his Fig. 13) gave *better* erosion scores and
   less divergence from the reference.
2. **Move to the lowest neighbour only** — removes the `d_total` sum and per-neighbour fractions.
3. **Move as much as possible:** `Δh = d_max / 2` **[quoted]** — levels `h` with its lowest neighbour when
   the difference exceeds `T`.
4. **Write the height map in place** (no double-buffer) — *"the hole would not receive any more material
   once it was raised to a level where the height differences to the surrounding cells were below the
   talus threshold"* **[quoted]**, which suppresses the spike artifact where 4 tall cells fill one pit.

Measured: **6× faster** than the reference (500 iterations in 10 s vs 60 s), scores 5 % worse after 500
iterations but **better in the first 80**, and stabilizes much sooner (most change in the first 50
iterations vs 150 for the reference).

```wgsl
// Olsen fast thermal, alternating the diagonal/axial neighbour set per pass.
@compute @workgroup_size(8,8)
fn thermalFast(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = i32(P.N); let x = i32(gid.x); let y = i32(gid.y);
  if (x >= n || y >= n) { return; }
  let i = u32(y*n + x);
  let h = hIn[i];

  // pass parity selects axial {(1,0),(0,1),(-1,0),(0,-1)} or diagonal {(1,1),(1,-1),(-1,1),(-1,-1)}
  var off: array<vec2<i32>,4>;
  if (P.parity == 0u) { off = array<vec2<i32>,4>(vec2(1,0),vec2(0,1),vec2(-1,0),vec2(0,-1)); }
  else                { off = array<vec2<i32>,4>(vec2(1,1),vec2(1,-1),vec2(-1,1),vec2(-1,-1)); }

  var dmax = 0.0; var best = -1;
  for (var k = 0; k < 4; k = k + 1) {
    let o = off[k];
    let hn = hIn[ix(x+o.x, y+o.y)];
    let dd = h - hn;
    if (dd > dmax) { dmax = dd; best = k; }
  }
  // diagonal steps are sqrt(2) longer -> scale the talus threshold accordingly
  let scale = select(1.0, 1.4142136, P.parity == 1u);
  let T = P.talus * scale;

  var dh = 0.0;
  if (best >= 0 && dmax > T) { dh = P.c * (dmax - T); }   // c <= 0.5
  hOut[i] = h - dh;
  // NOTE: the receiving side is handled by the *gather* pass below, not by scattering here.
}
```

**Gather, don't scatter.** The formulation above is a scatter (each cell pushes to a neighbour), which
needs atomics. The race-free GPU form is a **two-pass gather**:

* **Pass A (compute outflow):** every cell computes and writes its own outflow vector
  `o = (o_0..o_7)` — how much it *would* give to each neighbour. Pure local read, no conflict.
* **Pass B (apply):** every cell reads its own `o` and its 8 neighbours' `o` and computes
  `h' = h − Σ o_k + Σ_k o^{(neighbour k)}_{opposite(k)}`.

This is exactly Jákó's contribution (CESCG 2011, §2) **[quoted]**: *"we do not move ΔSi volumes directly
to cells in set A because this would introduce data write dependency … we put these quantities into eight
virtual pipes carrying material to the neighbours of this cell, then a separate simulation step updates
the terrain height for each cell by summarizing the incoming material flow."*

### 3.3 Pipe-based thermal erosion (Jákó 2011) — the production choice

**Source:** Jákó, CESCG 2011, equations 17–18 **[quoted]**:
```
H  = max{ b − b_i , i = 1..8 }                                     (max drop to any neighbour)
ΔS_{t+Δt} = a · Δt · Kt · R_t(x,y) · H / 2                         (17)   a = cell area
A  = { b_i : b − b_i < 0 ∧ tan(α) > (R(x,y)·Ka + Ki) }             (neighbours below the talus angle)
ΔS_i = ΔS · b_i / Σ_{b_k ∈ A} b_k                                  (18)
```
with `α = atan((b − b_i)/d)`, `d` the cell-to-cell distance.

> **Two corrections you must make when implementing eq. (18) [derived]:**
> (a) The set predicate is written `b − b_i < 0` but the intent (and the figure) is neighbours that are
>     **lower**, i.e. `b − b_i > 0` with the convention used elsewhere in the paper. Use "lower".
> (b) The proportioning `ΔS_i = ΔS · b_i / Σ b_k` divides by **absolute heights**, which is
>     origin-dependent (add 1000 to every height and the split changes). It must be proportional to the
>     *height differences*: `ΔS_i = ΔS · (b − b_i) / Σ_{k∈A}(b − b_k)`. This matches Musgrave/Olsen.

The talus threshold `tan α > R·Ka + Ki` makes the repose angle a function of **rock hardness** — soft
(recently deposited) material slumps at a shallower angle than bedrock. With `Ka = 0.8`, `Ki = 0.1`:
hardness `R=0` (hard) → `tanα > 0.1` (5.7°)… careful: in Jákó's convention *smaller* `R` = harder. If
you flip the convention (which is more intuitive: `R=1` = hard), use `tanα_min = Ki + (1−R)·Ka` so hard
rock holds steeper faces.

Full 8-pipe thermal state = `array<vec4<f32>>` ×2 (8 floats/cell = 32 B). Combine with hydraulic passes
in the order Jákó gives (§2, 7 steps) **[quoted]**:
```
1. water increment                      5. sediment transport (advection)
2. flow simulation                      6. thermal erosion material amount (apply pipes)
3. thermal soil outflow (fill pipes)    7. evaporation
4. erosion-deposition
```

### 3.4 Stable multi-pass scheme (recommended)

The single biggest practical problem is convergence speed. Use a **multi-scale, checkerboard, damped**
schedule:

```
for level in [N/16, N/8, N/4, N/2, N]:            # coarse-to-fine mip pyramid
    downsample h to `level`
    for pass in 1..K(level):                      # K ~ 20..40
        for parity in [0, 1]:                     # checkerboard / red-black
            thermalPass(level, parity, c = 0.5, talus = T(level))
    upsample the DELTA (not h) back and add
```

Rules that make this stable:

1. **`c ≤ 0.5`** always (§3.1).
2. **Red-black / checkerboard update.** Update only cells with `(x+y)&1 == parity` per dispatch. A cell
   and its 4-neighbours are never written in the same dispatch, so in-place updates are race-free *and*
   you get the Gauss-Seidel convergence speed-up (≈2× fewer iterations than Jacobi) plus Olsen's
   anti-spike behaviour. This is the single best trick in this section.
3. **Alternate axial/diagonal passes** (Olsen's rotated von Neumann): axial-only thermal erosion produces
   a visible `+`-shaped anisotropy; alternating removes it at no cost. Remember `T_diag = √2 · T_axial`.
4. **Scale the talus threshold with the level:** `T(level) = tan(θ) · worldSize / level / heightRange`.
   Coarse levels move mountains; fine levels only dress the surface.
5. **Multi-scale is a ~L× speed-up**: relaxing a feature of width `L` takes `O(L²)` fine passes but
   `O(L)` total passes in the pyramid.
6. **Talus angle by material:** typical angles of repose — dry sand 34°, gravel 38–45°, scree 35–40°,
   snow 38° (wet) to 50° (dry powder), fractured rock 45–60°. For gameplay terrain, `θ = 38°` for
   general ground and `θ = 30°` for a "sand" layer reads well.
7. **Terminate on change:** compute `Σ|Δh|` with the reduction of §9.5 every 8 passes; stop when it drops
   below `1e-6 · N²`.

**Worked example.** N = 2048, worldSize = 16 384 m (8 m/cell), heightRange = 1000 m, θ = 38°.
`T = tan(38°) · 8 m / 1000 m = 0.7813 · 0.008 = 0.00625` in normalized height units.
A 45° slope in the same units is `0.008`; so cells steeper than 0.00625 per step will slump.
With `c = 0.5` and ~40 passes per pyramid level × 5 levels = 200 dispatches ≈ 0.3 ms each ≈ **60 ms total**.

---

## 4. Advanced: landscape-evolution models and amplification

### 4.1 Stream power law (SPL) — fluvial incision

The governing equation of quantitative geomorphology, and the reason real mountain ranges have the
drainage patterns they do. Whipple & Tucker 1999; brought to graphics by Cordonnier et al. 2016.

**Cordonnier et al. eq. (1)** **[quoted]**:
```
dh(p)/dt = u(p) − k · A(p)^m · s(p)^n
```
* `h(p)` elevation, `u(p)` **tectonic uplift rate**, `A(p)` **drainage area** (upstream area through p),
  `s(p) = ∇h(p)` local slope, `k` erosion constant.
* **Exponents** **[quoted]**: *"the ratio m/n is constrained by the shape of the stream profiles and is
  thought of being m/n ≈ 0.5 … As in most geomorphological studies, we use n = 1 and m = 0.5."*

**Physical parameter values** used in the paper **[quoted]**:

| Quantity | Value |
|---|---|
| terrain size | 50 × 50 km² |
| max uplift `U` | `5.0 × 10⁻⁴ m·y⁻¹` ("the average uplift among earth mountains") |
| erosion rate `k` | `5.61 × 10⁻⁷ y⁻¹` (tuned so mountains culminate at ~2000 m) |
| time step `δt` | `2.5 × 10⁵ y` |
| iterations to converge | **100–300 steps** |
| valid scale range | `10⁵–10⁷` years, tens to hundreds of km |

**Steady state (the thing to internalize):** setting `dh/dt = 0` gives `s = (u/(k·A^m))^{1/n}`, i.e.
**slope ∝ A^(−m/n) = A^(−0.5)**. Channels get shallower downstream exactly as a power law of drainage
area. This is Flint's law, and it is why SPL output *looks* like a real mountain range and pure noise
does not.

**Why you cannot just forward-Euler it.** Explicit integration of `dh/dt = −k A^m s^n` requires
`δt < Δx / (k A^m)` which at large `A` is microscopic. The fix is the **implicit, O(N), parallel-friendly
scheme** of Braun & Willett (Geomorphology 180–181:170–179, 2013), reproduced by Cordonnier as eq. (2)
**[quoted]**:

```
                     h_i(t) + δt ( u_i + k A_i^m / ||p_i − p_j|| · h_j(t+δt) )
h_i(t + δt)  =  ───────────────────────────────────────────────────────────────
                           1 + k A_i^m / ||p_i − p_j|| · δt
```

where `X_j` is the **receiver** (steepest-descent downstream neighbour) of `X_i`.

**[quoted]** *"This scheme requires that h_j(t+δt) should be computed before h_i(t+δt), which is made
possible by parsing the previously computed trees from root to leaves. Thus, the implicit solver has an
O(N) complexity."*

This is **unconditionally stable** in `δt` — you can take 250 000-year steps. That is the whole trick.

**Implementation outline (grid version, fully GPU-able except the tree traversal):**
```
loop until converged:
  1. fill depressions (§5.4)                          -> no internal sinks
  2. D8 or D∞ receivers (§5.1/5.2)                    -> a forest of trees rooted at the boundary
  3. flow accumulation A (§5.3)                       -> topological order gives it in O(N)
  4. traverse each tree ROOT->LEAVES applying eq.(2)  -> h(t+dt)
  5. thermal correction: clamp any slope above 30 deg (below)
```

**Thermal correction** **[quoted]**: *"if the result of the stream power equation leads to slopes higher
than 30°, we reduce the change of elevation so as to keep slopes in the prescribed range."* Without it,
low-drainage-area nodes grow *"unrealistic sharp and high peaks"* **[quoted]**.

**Convergence test** **[quoted]**: track **changes in the topology of the stream graph**, not elevation
deltas — *"we found that tracking changes in the topology of the stream graph is an accurate predictor."*

**What SPL buys you:** globally coherent, correctly-scaled **dendritic drainage networks and ridge
lines**, with a user-paintable `u(p)` uplift map as the control. Nothing else in this document produces
plausible *continental-scale* structure. It is the right tool for the 1000-km base shape; it is the wrong
tool for surface detail (feed its output into §2/§3).

**Cost:** O(N) per iteration, 100–300 iterations. On a 1024² grid this is sub-second on CPU. Steps 1 and 4
are inherently sequential (priority queue / tree traversal), so this often stays on CPU (or a compute
pass with pointer-doubling, §5.3) while steps 2–3 go on GPU.

### 4.2 Cordonnier et al. 2016 — tectonic uplift + fluvial erosion

**Source:** G. Cordonnier, J. Braun, M.-P. Cani, B. Benes, E. Galin, A. Peytavie, É. Guérin,
*"Large Scale Terrain Generation from Tectonic Uplift and Fluvial Erosion"*, Computer Graphics Forum 35(2)
(Eurographics 2016), pp. 165–175.
PDF: <https://www.cs.purdue.edu/cgvlab/www/resources/papers/Cordonnier-Computer_Graphics_Forum-2016-Large_Scale_Terrain_Generation_from_Tectonic_Uplift_and_Fluvial_.pdf>

Algorithm (paper §3.2) **[quoted]**: input = a user-painted **uplift map** `U` over domain Ω, represented
as a **random planar graph** `G` (not a regular grid — this is the key departure). Iterate until stable:
```
1. extract a set of oriented stream trees T from current elevations h_k(t)   (each node -> lowest neighbour = its "receiver")
2. augment T with arcs for lakes overflowing into streams  -> T~
3. compute drainage areas A_k   (BFS order P, then accumulate in REVERSE order: leaves -> root, O(N))
4. solve the stream power equation (1) via eq. (2) for h_k(t+δt)
```
Slope **[quoted]**: `s(p_k) = (h_k − h_l) / ||p_k − p_l||` with `X_l` the receiver of `X_k`.
Drainage area **[quoted]**: *"we perform a breadth first traversal of the tree, storing each node in
parsing order in a set P. Then we compute the drainage area for each node of P, parsed in the reverse
order, i.e., from leaves to the root … This enables us to compute A in linear time."*

**Rendering/amplification:** the converged stream graph is converted to a DEM by *"blending landform
feature kernels whose parameters are derived from the information in the graph"* **[quoted]** — i.e. the
graph carries semantics (this arc is a river of drainage area A; this node is a ridge at elevation h) and
you instantiate procedural primitives per feature. This gives **continuous LOD** — you can zoom in
arbitrarily far, because the primitives are functions, not samples.

**What it buys you:** high-level control (paint uplift, get a mountain range with correct watersheds,
river networks and ridges), at low cost (a desktop CPU, ~seconds), with LOD-free zoom.
**Adopt this if:** you want the *layout* to be authored and the *structure* to be earned.

### 4.3 Guérin et al. 2016 — sparse representation & terrain amplification

**Source:** É. Guérin, J. Digne, E. Galin, A. Peytavie, *"Sparse representation of terrains for procedural
modeling"*, CGF 35(2) (Eurographics 2016), pp. 177–187.
PDF: <https://perso.liris.cnrs.fr/eguerin/download/eg2016.pdf> · Code:
<https://github.com/eric-guerin/terrain-amplification>

Model: a **Sparse Construction Tree**. Leaves are **atoms** — compactly-supported landform features on a
disc of constant radius `R` — stored in a **dictionary** `D` of `N` atoms; internal nodes are blending
operators. A terrain patch is reconstructed as a **sparse linear combination of a few atoms**
(sparsity `s` = number of non-zero coefficients) **[quoted]**.

* Atoms are either **data-based** (a vectorized patch of a real DEM, bicubically interpolated) or
  **function-based** (*"defined as sums of ridged noise"* **[quoted]**).
* Decomposition uses **Orthogonal Matching Pursuit (OMP)** (Mallat & Zhang 1993) **[quoted]**: repeatedly
  pick the atom best correlated with the residual, remove its projection, iterate until the sparsity
  target is met.
* The dictionary is learned with **K-SVD** (Aharon, Elad, Bruckstein 2006) **[quoted]**.
* Relationship between the sizes **[quoted]**: `s ≪ N ≪ n` (sparsity ≪ dictionary size ≪ number of
  terrain patches).
* **Multi-resolution dictionary** `(H, L)`: a high- and a low-resolution dictionary with the *same number
  of atoms* and a one-to-one correspondence, so *"given the decomposition over the low resolution
  dictionary L, the decomposition on the high resolution dictionary H can be obtained simply by keeping"*
  the same coefficients **[quoted]**.

**That last bullet IS terrain amplification.** Decompose your coarse (procedural / hand-sketched) terrain
over `L`, then rebuild with `H` using the *same* sparse coefficients → you get real-world high-frequency
landform detail (from the exemplar DEMs the dictionary was learned from) grafted onto your coarse shape,
while preserving the coarse layout. Reported PSNR is good *"even for very small sparsity values"*, and
sparsity `s = 1` already gives ~20 dB **[quoted]**.

**What it buys you:** exemplar-driven realism without a sim, plus compression (they report large storage
reduction ratios) and inverse procedural modelling. **Cost:** OMP is the expensive part (per patch, per
iteration `s` dot-products against all `N` atoms) but it is embarrassingly parallel and done once offline.

### 4.4 Other results worth knowing

| Work | What it buys you |
|---|---|
| Braun & Willett 2013, *"A very efficient O(n), implicit and parallel method to solve the stream power equation"*, Geomorphology 180–181:170–179 | The implicit SPL solver itself. If you implement §4.1, read this. |
| Schott, Paris, Fournier, Guérin, Galin, *"Large-scale Terrain Authoring through Interactive Erosion Simulation"*, ACM TOG 42(5), 2023, <https://dl.acm.org/doi/10.1145/3592787> | Brings full hydraulic+thermal+debris erosion to **interactive** authoring at large scale; sparse/adaptive update so you only simulate where the user is painting. |
| Cordonnier et al., *"Authoring landscapes by combining ecosystem and terrain erosion simulation"*, SIGGRAPH 2017 | Couples vegetation to erosion (roots resist erosion, erosion kills plants). Gives you the hardness field `R` for free, and much better-looking foothills. |
| Guérin et al., *"Interactive Example-Based Terrain Authoring with Conditional GANs"*, ACM TOG 36(6), 2017 | Sketch-to-terrain: user draws ridge/river/altitude strokes, cGAN synthesizes the DEM. The fastest path to "authoring feels like drawing". |
| Musgrave, Kolb, Mace 1989 (SIGGRAPH '89) | The original thermal + hydraulic formulation; still the base of §3. |
| Paris et al., *"Desertscape Simulation"*, CGF 2019 | Aeolian (wind) transport, dunes — the missing third erosion family. |

---

## 5. Flow direction, accumulation, depressions, watersheds, rivers

Everything in this section assumes a **depression-free** DEM. Run §5.4 first, or every accumulation
algorithm will stall in pits.

### 5.1 D8 flow direction (O'Callaghan & Mark 1984)

Each cell drains entirely to the one neighbour with the steepest *downward* gradient, where the gradient
is corrected for diagonal distance:

```wgsl
// slope_k = (h - h_k) / dist_k ,  dist = 1 for axial, sqrt(2) for diagonal
const D8_OFF = array<vec2<i32>,8>(vec2(0,-1),vec2(1,-1),vec2(1,0),vec2(1,1),
                                  vec2(0,1),vec2(-1,1),vec2(-1,0),vec2(-1,-1));
const D8_DIST = array<f32,8>(1.0, 1.4142136, 1.0, 1.4142136, 1.0, 1.4142136, 1.0, 1.4142136);

fn d8(x: i32, y: i32) -> i32 {          // returns 0..7, or -1 if no downhill neighbour
  let h = hIn[ix(x,y)];
  var best = -1; var bestSlope = 0.0;
  for (var k = 0; k < 8; k = k + 1) {
    let o = D8_OFF[k];
    let s = (h - hIn[ix(x+o.x, y+o.y)]) / (D8_DIST[k] * P.cellSize);
    if (s > bestSlope) { bestSlope = s; best = k; }
  }
  return best;
}
```

* **Encoding:** store the *index* 0–7 in a `u32` buffer (or the classic ESRI power-of-two code
  1,2,4,…,128). Using the index makes the neighbour lookup a table read.
* **Ties:** pick the lowest index (deterministic). Ties are rare in float data but common after
  depression filling with `ε = 0`; use the `+ε` fill (§5.4) to avoid flat ties entirely.
* **Weakness (the reason D∞ exists):** flow is quantized to 8 directions, so on a smooth conical hill the
  accumulation forms **8 radial spokes** instead of a uniform fan. This is *grid bias* and it is very
  visible if you use accumulation to drive river carving.

### 5.2 D-infinity (Tarboton 1997)

**Source:** D. G. Tarboton, *"A new method for the determination of flow directions and upslope areas in
grid digital elevation models"*, Water Resources Research 33(2):309–319, 1997.
PDF: <https://hydrology.usu.edu/dtarb/96wr03137.pdf>

Flow direction is a **continuous angle** in [0, 2π), taken as *"the steepest downward slope on the eight
triangular facets centered at each grid point"* **[quoted]**. Flow is then split between the **two**
neighbours bracketing that angle.

Per facet, with `e0` the centre, `e1` the side neighbour, `e2` the diagonal neighbour
(Tarboton eqs. 1–5) **[quoted]**:
```
s1 = (e0 − e1) / d1
s2 = (e1 − e2) / d2
r  = atan(s2 / s1)
s  = sqrt(s1² + s2²)

if r < 0:                r = 0,                s = s1
if r > atan(d2/d1):      r = atan(d2/d1),      s = (e0 − e2) / sqrt(d1² + d2²)
```
Global angle (eq. 6) **[quoted]**: `rg = af · r' + ac · π/2`, with `r'` = `r` of the winning facet.

**Table 1 of the paper, verbatim** **[quoted]** — this is the whole implementation:

| Facet | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| `e0` | `e(i,j)` | `e(i,j)` | `e(i,j)` | `e(i,j)` | `e(i,j)` | `e(i,j)` | `e(i,j)` | `e(i,j)` |
| `e1` | `e(i,j+1)` | `e(i−1,j)` | `e(i−1,j)` | `e(i,j−1)` | `e(i,j−1)` | `e(i+1,j)` | `e(i+1,j)` | `e(i,j+1)` |
| `e2` | `e(i−1,j+1)` | `e(i−1,j+1)` | `e(i−1,j−1)` | `e(i−1,j−1)` | `e(i+1,j−1)` | `e(i+1,j−1)` | `e(i+1,j+1)` | `e(i+1,j+1)` |
| `ac` | 0 | 1 | 1 | 2 | 2 | 3 | 3 | 4 |
| `af` | 1 | −1 | 1 | −1 | 1 | −1 | 1 | −1 |

`d1` = axial spacing, `d2` = the orthogonal spacing (both = cellSize on a square grid).

Search order is facets 1→8, **ties pick the first** **[quoted]**: *"In nature ties are extremely rare so
the bias introduced by this is deemed negligible."*
Unresolved (pit/flat, no positive downslope) is flagged with **angle = −1** **[quoted]**, then resolved by
falling back to D8 after depression filling.

**Flow proportioning** (Tarboton, "Calculation of Upslope Areas") **[quoted]**: flow is split between the
two adjacent neighbours *"according to how close the flow direction angle is to the direct angle to those
pixels"*. Concretely, if `rg` falls between neighbour directions `θ_a` and `θ_b = θ_a + π/4`:
```
p_a = (θ_b − rg) / (π/4)
p_b = 1 − p_a
```
**[quoted]** *"flow is never proportioned between more than two downslope pixels"* — that is what keeps
D∞'s dispersion below MFD's while removing D8's grid bias.

**Use D8 when** you need discrete single-parent trees (SPL §4.1, watershed labeling, priority-flood).
**Use D∞ when** the accumulation map is a *texture input* (wetness, river masks, TWI) — the difference is
night and day on smooth slopes.

### 5.3 Flow accumulation

`A(c) = area(c) + Σ_{u → c} p(u→c) · A(u)`.

#### (a) Topological / O(n) — the right way
```
1. compute receivers (D8) and, for each cell, its in-degree (number of donors)
2. seed a queue with all cells of in-degree 0 (ridge tops)
3. pop c: add A(c) to its receiver; decrement receiver's in-degree; if it hits 0, push it
4. repeat until the queue empties
```
Exactly `n` pops, no sorting, no priority queue. Requires a depression-free DEM (otherwise cycles).
For D∞, "in-degree" counts donors with non-zero proportion, and step 3 adds `p·A(c)` to each of the two
receivers. This is the same reverse-BFS Cordonnier uses for drainage area (§4.2) **[quoted]**.

#### (b) Sorted-by-elevation — simplest correct version
Sort all cells descending by height (`O(n log n)`, or `O(n)` with a radix sort on the float bit pattern,
§9.6), then sweep: each cell pushes its accumulation to its receiver(s). Because you process high → low,
every donor is already finished. **This is the easiest one to get right; do this first.**

#### (c) GPU: pointer doubling (path-halving)
Fully parallel, `O(n log n)` work in `O(log n)` dispatches:
```
rcv[i]  = receiver of i                    // one pass
acc[i]  = 1                                // cell's own area
for step in 0..log2(N²):
    acc2[rcv[i]] += acc[i]     (atomicAdd on u32 / fixed-point i32)
    rcv[i] = rcv[rcv[i]]                   // pointer doubling: jump 2x further each round
```
In practice **~2·log2(N)** dispatches (22 at N = 2048) and it is ~5–20× faster than a CPU round trip
including transfer. Use `atomicAdd` on a `array<atomic<u32>>` (areas are integers — cell counts — so u32
atomics are exact and order-independent → deterministic). For D∞'s fractional weights, use fixed-point
`atomic<u32>` with a `2^16` scale.

#### (d) GPU: iterative relaxation (simplest, good enough)
```
repeat K times:  acc_new[c] = 1 + Σ over the 8 neighbours n with rcv[n]==c of acc_old[n]
```
This is a pure gather (no atomics!) and converges in `K = longest flow path length` iterations
(typically `1–3 × N`). Too slow alone, but **perfect inside a mip pyramid**: solve at N/8, upsample as an
initial guess, do 20 refinement iterations per level. Usually 60–100 total dispatches at 2048².

**Range gotcha:** at 4096², `A` reaches 16.7 M — fits in u32, does **not** fit in f32 without losing
integer exactness above 16.7 M (`2^24`). Use `u32` for cell counts, convert to f32 (or better,
`log(1+A)`) only for display/texturing.

### 5.4 Depression filling

#### (a) Priority-Flood (Barnes, Lehman, Mulla 2014) — use this
**Source:** R. Barnes, C. Lehman, D. Mulla, *"Priority-Flood: An Optimal Depression-Filling and
Watershed-Labeling Algorithm for Digital Elevation Models"*, Computers & Geosciences 62:117–127, 2014.
arXiv: <https://arxiv.org/abs/1511.04463>

**Algorithm 1 (the generalization), verbatim [quoted, arXiv lines 265–278]:**
```
Require: DEM
 1: Let Open be a priority queue
 2: Let Closed have the same dimensions as DEM
 3: Let Closed be initialized to false
 4: for all c on the edges of DEM do
 5:   Push c onto Open with priority DEM(c)
 6:   Closed(c) <- true
 7: while Open is not empty do
 8:   c <- pop(Open)
 9:   for all neighbors n of c do
10:     if Closed(n) then repeat loop
11:     DEM(n) <- max(DEM(n), DEM(c))
12:     Closed(n) <- true
13:     Push n onto Open with priority DEM(n)
```

**Algorithm 2 "Improved Priority-Flood", verbatim [quoted, arXiv lines 393–413]** — adds a plain FIFO to
fill a depression once its outlet is known, which is the big constant-factor win:
```
 1: Let Open be a priority queue
 2: Let Pit be a plain queue
 3: Let Closed have the same dimensions as DEM ; initialized to false
 5: for all c on the edges of DEM do
 6:   Push c onto Open with priority DEM(c) ; Closed(c) <- true
 8: while either Open or Pit is not empty do
 9:   if Pit is not empty then c <- pop(Pit)
12:   else                    c <- pop(Open)
13:   for all neighbors n of c do
14:     if Closed(n) then repeat loop
15:     Closed(n) <- true
16:     if DEM(n) <= DEM(c) then
17:       DEM(n) <- DEM(c)
18:       Push n onto Pit
19:     else
20:       Push n onto Open with priority DEM(n)
```

**Complexity [quoted]:** *"in O(m log₂ m) time, where m ≤ n, on floating-point data and in O(n) time on
integer data. By comparison, the Planchon–Darboux Algorithm has a time complexity of at least O(n^1.2)
and the generalized Priority-Flood Algorithm has a time complexity of O(n log₂ n) for floating-point DEMs
and O(n) for integer DEMs."*

**Algorithm 3 "Priority-Flood+ε" [quoted, arXiv lines 597–627]** — fills so that every filled cell is
strictly higher than its downstream neighbour, so flow directions are always defined (no flats):
the key line is `DEM(n) <- NextAfter(DEM(c), ∞)` (C99 `nextafterf`). Barnes explicitly warns
**[quoted]**: *"If too small an ε is used, then adding it to a cell may produce no change in its
elevation; if too great an ε is used, then large depressions may be converted into mesas rising above the
surrounding landscape."* Use `nextafterf`, not a hardcoded `1e-6`.
WGSL has no `nextafter`; implement it by bit-manipulation:
```wgsl
fn nextAfterUp(x: f32) -> f32 {
  if (x == 0.0) { return bitcast<f32>(1u); }             // smallest subnormal
  let b = bitcast<u32>(x);
  return bitcast<f32>(select(b - 1u, b + 1u, x > 0.0));
}
```

**Ordering [quoted]:** with `ε = 0`, a strict-weak-order priority queue is fine. With `ε ≠ 0`, or for
watershed labeling or flow directions, you need a **total order** — pair each cell's elevation with a
monotonically increasing insertion counter as a tiebreaker.

**Algorithm 4 "Priority-Flood+FlowDirs" [quoted, lines 693–712]** — a depression-*carving* variant: it
never modifies the DEM, it just assigns every cell a flow direction pointing toward the cell that popped
before it. *"On 8-connected grids, non-diagonal neighbors should be processed first … as they have the
greatest center-to-center slopes."* **[quoted]** Often better for terrain generation than filling,
because filling creates dead-flat lake surfaces that look wrong; carving preserves the bathymetry and
still gives you a valid drainage graph.

**Algorithm 5 "Improved Priority-Flood + Watershed Labels" [quoted, lines 743–763]** — see §5.5.

#### (b) Planchon & Darboux (2002)
**Source:** O. Planchon, F. Darboux, *"A fast, simple and versatile algorithm to fill the depressions of
digital elevation models"*, Catena 46(2–3):159–176, 2002.
PDF: <https://horizon.documentation.ird.fr/exl-doc/pleins_textes/divers20-05/010031925.pdf>

Idea **[quoted from the abstract]**: *"instead of gradually filling the depressions, it first inundates
the surface with a thick layer of water and then removes the excess water."*

**Stage 1 — initialization (paper Table 3) [quoted]:**
```
1 For each cell c of the DEM (in any order)
2   If c is on the border Then
3     W(c) = Z(c)
4   Else
5     W(c) = a_huge_number
6   End If
7 End For
```

**Stage 2 — removal of excess water (paper Table 4) [quoted]:**
```
 1 For each cell c of the DEM (in any order)
 2   For each neighbour n of c (in any order)
 3     Determine e for the pair (c,n)
 4     If possible, apply operation (1)
 5     Else, try to apply operation (2)
 6   End For
 7 End For
 8 If W was modified during this scan, Then
 9   Go to line 1
10 End If
```
with the two operations **[quoted]**:
```
Operation (1):  Z(c) >= W(n) + e(c,n)                =>  W(c) = Z(c)
Operation (2):  W(c) >  W(n) + e(c,n) > Z(c)         =>  W(c) = W(n) + e(c,n)
```
Once operation (1) fires for a cell, `W(c)` has reached its final value and never changes again — that is
the convergence argument.

**Why it is still interesting despite being slower:** stage 2 is a **pure stencil relaxation over the
whole grid with no queue** — it maps perfectly onto a GPU compute pass (unlike priority-flood, which is
inherently sequential). The naive implementation is `O(n^1.5)`; the authors' optimized version
(48 constants, multi-direction scans, recursive upstream search) is `O(n^1.2)` **[quoted from Barnes'
survey]**.

**GPU recipe [derived]:** run stage 1 as one dispatch; run stage 2 as a red-black relaxation
(`(x+y)&1` parity) reading `W` in place; every 16 passes, reduce a "changed" flag
(`atomicOr` into a single u32) and stop when it is 0. On a 2048² map with typical terrain this converges
in a few hundred passes (≈50 ms) — slower than a CPU priority-flood (≈100 ms + 32 MiB of transfers each
way), so it wins mainly when the data is already resident on the GPU.

**Pragmatic recommendation:** priority-flood **+ε on the CPU** (TypeScript, a flat typed-array binary
heap; ~250 ms at 2048², ~1.2 s at 4096²), run once per pipeline, not per erosion iteration.

### 5.5 Watershed extraction

**Algorithm 5 of Barnes et al., verbatim [quoted, arXiv lines 743–763]:**
```
Require: DEM, Labels
 1: Let Open be a priority queue
 2: Let Pit be a plain queue holding cells' (x,y,z)
 3: Let Labels have the same dimensions as DEM ; initialized to "candidate"
 5: label <- 1
 6: for all c on the edges of DEM do
 7:   Push c onto Open with priority DEM(c) ; Labels(c) <- queued
 9: while either Open or Pit is not empty do
10:   if Pit is not empty then c <- pop(Pit) else c <- pop(Open)
14:   if Labels(c) = queued and DEM(c) != NoData then
15:     Labels(c) <- label ; Increment label
17:   for all neighbors n of c do
18:     if Labels(n) != candidate then repeat loop
19:     Labels(n) <- Labels(c)
20:     if DEM(n) <= c.z then Push n onto Pit with z = c.z
21:     else                  Push n onto Open with priority DEM(n)
```
Result **[quoted]**: *"All cells which drain to a common point at the edge of the DEM bear the same
label."* This is the Beucher–Meyer marker-based watershed adapted to priority-flood; note it runs in the
same pass as the filling, so watershed labels are essentially free.

**Alternative (and simpler if you already have D8):** union-find / pointer-chasing on the receiver graph.
Every cell's watershed = the label of the root of its receiver tree. On GPU, run the pointer-doubling loop
of §5.3(c) but carry the *root index* instead of accumulation: after `log2(n)` doublings every cell points
directly at its root. Deterministic and fully parallel.

### 5.6 River network extraction

```
1. fill (+eps) the DEM                                       §5.4
2. D8 (structure) or D-inf (texture) flow directions          §5.1/5.2
3. flow accumulation A                                        §5.3
4. channel mask: A > A_crit
5. thin / order the network, then carve
```

* **Critical support area `A_crit`**: the standard channel-initiation criterion. Geomorphologically
  `A_crit ≈ 10⁴–10⁶ m²`. On a grid, `A_crit = c / cellArea` cells. Practical values: **0.1 %–1 % of the
  map's cell count** (at 2048² → 4 000–42 000 cells). Lower `A_crit` = denser, more dendritic network.
* **Slope-dependent threshold** (better): `A · S^θ > C` with `θ ≈ 1.7–2.0` — channels start sooner on
  steep ground, which is what actually happens.
* **Strahler order** (for river width / rendering): leaves = order 1; when two streams of equal order `k`
  join → `k+1`; otherwise `max`. Compute it in the same topological sweep as accumulation.
* **Width from discharge** (hydraulic geometry, Leopold & Maddock 1953): `w = a · Q^b` with
  `b ≈ 0.5`, and `Q ∝ A`. So **river width ∝ √(drainage area)** — use
  `w_cells = w0 * sqrt(A / A_crit)`, clamped. This single formula is what makes a carved river network
  read as real.
* **Carving** (see also §7.2):
  ```
  depth(p) = d0 * pow(A(p)/A_crit, 0.35)                 # deeper downstream
  h(p) -= depth(p) * profile(dist_to_channel / w(p))     # profile: smoothstep or 1-x^2
  ```
  Enforce **downstream monotonicity** afterwards (one pass along the flow order: `h_child = min(h_child,
  h_parent - epsilon)`) or your river will run uphill.
* **Smoothing `A` before use:** raw accumulation is extremely high-contrast (1 → 10⁶). Always use
  `log(1 + A)` for anything continuous (wetness, texture blending, width), and apply a small blur to
  `log(1+A)` before using it as a mask, otherwise the 1-cell-wide D8 lines alias badly.

---

## 6. Derived maps for texturing and gameplay

All formulas below assume `h` sampled on a regular grid with spacing `L` (world units per cell) and
the 3×3 neighbourhood labelled:

```
Z1 Z2 Z3        a b c
Z4 Z5 Z6   ==   d e f      (Z5 = e = the centre cell)
Z7 Z8 Z9        g h i
```

### 6.1 Slope and aspect (Horn 1981 — the ArcGIS/GDAL standard)

```wgsl
let dzdx = ((c + 2.0*f + i) - (a + 2.0*d + g)) / (8.0 * L);
let dzdy = ((g + 2.0*h + i) - (a + 2.0*b + c)) / (8.0 * L);

let slopeRad = atan(sqrt(dzdx*dzdx + dzdy*dzdy));       // 0..pi/2
let slopePct = 100.0 * sqrt(dzdx*dzdx + dzdy*dzdy);
let aspect   = atan2(dzdy, -dzdx);                      // radians CCW from east
// convert to compass degrees (0 = north, clockwise):
let aspectDeg = (450.0 - degrees(aspect)) % 360.0;
```
Horn's `1-2-1` weighting is a mild low-pass, which is exactly what you want for texturing (a raw central
difference is noisy on eroded terrain). For *physics/normals* use the plain central difference
`(f - d)/(2L)`, which is unbiased.

**Surface normal** (right-handed, `+y` up in world space, grid `+z` = south):
```wgsl
let n = normalize(vec3<f32>(-dzdx, 1.0, -dzdy));
```
**Normal in a normalized [0,1] heightfield:** multiply by `heightRange / L` before normalizing, or your
normals will be wrong by the aspect ratio — the single most common terrain-shading bug.

### 6.2 Curvature (Zevenbergen & Thorne 1987)

Fit the partial quartic `Z = Ax²y² + Bx²y + Cxy² + Dx² + Ey² + Fxy + Gx + Hy + I` through the 3×3
window. The coefficients you need:

```wgsl
let D = ((d + f) * 0.5 - e) / (L*L);        // ~ z_xx / 2
let E = ((b + h) * 0.5 - e) / (L*L);        // ~ z_yy / 2
let F = (-a + c + g - i) / (4.0*L*L);       // ~ z_xy
let G = (-d + f) / (2.0*L);                 // z_x
let H = (b - h) / (2.0*L);                  // z_y
let p = G*G + H*H;                          // |grad|^2
```

| Map | Formula | Sign convention |
|---|---|---|
| **Profile curvature** (down-slope) | `-2.0*(D*G*G + E*H*H + F*G*H) / max(p, 1e-8)` | **negative = convex** (slope accelerating, erosion zone) |
| **Plan curvature** (across-slope) | ` 2.0*(D*H*H + E*G*G - F*G*H) / max(p, 1e-8)` | **positive = convergent** (valleys, wet) |
| **General curvature** | `-2.0*(D + E)` | ArcGIS multiplies by 100 |
| **Mean curvature** `H_m` | `((1+G*G)*2E - 2*G*H*F + (1+H*H)*2D) / (2*pow(1+p, 1.5))` | true differential-geometry mean curvature (z_xx=2D, z_yy=2E, z_xy=F) |
| **Gaussian curvature** `K` | `(2D*2E - F*F) / ((1+p)*(1+p))` | `K>0` dome/pit, `K<0` saddle |

**Practical use:** `plan curvature > 0` is the single best cheap "water collects here" mask
(moss, darker soil, vegetation). `profile curvature < 0` marks ridge crests and cliff brinks (exposed
rock, snow blown off). **Guard `p` with `max(p, 1e-8)`** — on perfectly flat cells both curvatures are 0/0.

Curvature is a **second derivative**, so it amplifies noise by `1/L²`. Always compute it from a
*smoothed* copy of `h` (one 3×3 binomial blur) or from a coarser mip; otherwise you get a salt-and-pepper
mask.

### 6.3 Ambient occlusion (horizon / ray-marched on the heightfield)

For a heightfield you never need a real ray tracer — march the height map along `K` azimuths and find the
maximum elevation angle ("horizon angle") per azimuth.

```wgsl
// Horizon-based AO on a heightfield. numDirs x numSteps taps.
fn horizonAO(p: vec2<i32>, numDirs: i32, numSteps: i32, maxDistCells: f32) -> vec2<f32> {
  let h0 = hIn[ix(p.x, p.y)];
  var occCos = 0.0;     // cosine-weighted (for diffuse AO)
  var occUni = 0.0;     // uniform (for sky visibility)
  for (var d = 0; d < numDirs; d = d + 1) {
    let ang = (f32(d) + 0.5) * 6.28318530718 / f32(numDirs);
    let dir = vec2<f32>(cos(ang), sin(ang));
    var sinH = 0.0;                                       // sin of the max elevation angle so far
    var t = 1.0;
    let step = maxDistCells / f32(numSteps);
    for (var s = 0; s < numSteps; s = s + 1) {
      let q = vec2<f32>(p) + dir * t;
      let hq = sampleBilinear(q);
      let dz = (hq - h0) * P.heightScale;                 // world units
      let dxy = t * P.cellSize;                           // world units
      sinH = max(sinH, dz / sqrt(dz*dz + dxy*dxy));       // = sin(atan(dz/dxy))
      t = t + step;
      // optional: step *= 1.15 (geometric march) to cover long distances cheaply
    }
    occCos = occCos + (1.0 - sinH*sinH);                  // cos^2(horizon) - see derivation
    occUni = occUni + (1.0 - sinH);
  }
  return vec2<f32>(occCos, occUni) / f32(numDirs);
}
```

**Derivation of the two weights [derived].** Let `φ_h` be the horizon elevation angle for one azimuth
sector. For a horizontal surface with the normal up, the direction at elevation `φ` has
`cos(θ_normal) = sin φ` and `dω = cos φ dφ dψ`.
* Cosine-weighted (diffuse AO): `∫_{φ_h}^{π/2} sin φ cos φ dφ = (1 − sin²φ_h)/2`; the full hemisphere
  gives `1/2`, so the normalized per-sector visibility is **`1 − sin²φ_h = cos²φ_h`**.
* Uniform (sky/dome visibility): `∫_{φ_h}^{π/2} cos φ dφ = 1 − sin φ_h`, full = 1, so per-sector
  visibility is **`1 − sin φ_h`**.

This matches HBAO (Bavoil, Sainz & Dimitrov, *"Image-Space Horizon-Based Ambient Occlusion"*, SIGGRAPH
2008 talk) applied to a heightfield instead of a depth buffer.

**Tuning**
| Param | Range | Default | Note |
|---|---|---|---|
| `numDirs` | 8–32 | **16** | below 8 you see banding; jitter the start angle per pixel with blue noise and use 8 |
| `numSteps` | 8–64 | **24** | geometric stepping (`step *= 1.1`) covers 10× the distance for the same count |
| `maxDistCells` | 0.05–0.25 × N | **0.1 × N** | this sets the *scale* of the shadowing; too large = muddy, too small = only local crevices |

**Cost:** `numDirs × numSteps` bilinear taps per pixel. 16×24 = 384 taps × 4.2 M cells = **1.6 G taps**
at 2048² → ~0.5–2 s. Mitigations that work:
* **Mip-march:** sample a max-mipmap (a "maximum height" pyramid) and take bigger steps at higher mips —
  this is cone-stepping and cuts the step count to ~8 per direction.
* Compute AO at half resolution and bilaterally upsample (the map is low-frequency anyway).
* Tile the dispatch (§9.8) so you don't trip the browser's watchdog.

**Cavity / crevice map** (short-range AO, for texture darkening in cracks):
```wgsl
// difference of Gaussians; negative = concave
let cav = clamp(0.5 + P.cavityGain * (blur(h, 2.0) - h) / P.cavityScale, 0.0, 1.0);
```
Cheap (two blurs), and it correlates well with curvature but is much less noisy.

### 6.4 Wetness / Topographic Wetness Index

Beven & Kirkby 1979 (TOPMODEL):
```
TWI = ln( a / tan β )
```
* `a` = **specific catchment area** = `A / L` (upslope area per unit contour width). On a grid,
  `a = A_cells · cellArea / L = A_cells · L`.
* `β` = local slope angle. `tan β = |∇h|`.

```wgsl
let a    = max(f32(accum[i]), 1.0) * P.cellSize;       // m^2 per m of contour
let tanB = max(sqrt(dzdx*dzdx + dzdy*dzdy), 0.001);    // guard flats
let twi  = log(a / tanB);
```
Typical range 3–25; remap with `smoothstep(6.0, 14.0, twi)` for a wetness mask.
`tan β` **must** be floored (0.001 is the standard choice) or flats produce `+inf`.

**Cheaper alternatives that look nearly as good:**
* `wet = smoothstep(0.0, 1.0, plan_curvature_normalized) * (1 - slope01)` — no accumulation needed.
* If you ran the pipe model, just use the water field `d` directly (smoothed), plus a "was ever wet"
  accumulator `maxd` — this is strictly better than TWI because it accounts for the actual simulation.

### 6.5 Insolation (sun exposure)

**Instantaneous** for sun direction `s` (unit vector, world space):
```wgsl
let lambert = max(0.0, dot(n, s));
let shadow  = rayMarchShadow(p, s);                 // 1 = lit, 0 = shadowed
let E = lambert * shadow * directIrradiance
      + skyVisibility * diffuseIrradiance;          // skyVisibility from §6.3
```

**Sun position** from latitude `φ`, day-of-year `n`, hour angle `ω = 15°·(t_solar − 12)`:
```
declination:  δ = 23.45° · sin( 360° · (284 + n) / 365 )        (Cooper 1969)
altitude:     sin(alt) = sin φ sin δ + cos φ cos δ cos ω
azimuth:      cos(az)  = (sin δ cos φ − cos δ sin φ cos ω) / cos(alt)      (az measured from north)
```

**Annual/seasonal insolation map** (the useful one for vegetation and snow masks): accumulate over a
sampled sun path — e.g. 12 days × 12 hours = 144 sun positions; for each, one shadow-march pass over the
whole grid. 144 × (a 32-step march) at 2048² ≈ a few seconds. Optimizations:
* Only accumulate positions with `alt > 0`.
* Reuse the **horizon map** from §6.3: if you store the horizon angle per azimuth bin
  (`numDirs` values per cell, e.g. 16 × f16 = 32 B/cell), then shadowing for *any* sun direction is a
  single lookup+compare (`lit = sin(alt) > sinH[bin(az)]`). This turns a 144-pass ray march into
  144 cheap texture reads. **Do this.**

Derived masks:
* **North-facing / shaded** (northern hemisphere): low insolation → moss, snow retention, conifers.
* **South-facing**: high insolation → dry grass, exposed rock, scrub.

### 6.6 Summary of the texture-driving map set

| Map | Source | Typical use |
|---|---|---|
| `slope01` | §6.1 | rock vs grass; buildability |
| `aspect` | §6.1 | biome asymmetry |
| `planCurv` | §6.2 | wet crease darkening |
| `profCurv` | §6.2 | crest highlighting, snow blow-off |
| `ao` | §6.3 | ambient darkening |
| `sky` | §6.3 | sky-light term, snow accumulation |
| `cavity` | §6.3 | fine crack darkening |
| `twi` / `logA` | §5.3, §6.4 | rivers, wet soil, vegetation density |
| `insolation` | §6.5 | biome, snowline modulation |
| `sediment` | §2.1 `s` field | sand/silt deposits, deltas, river bars |
| `hardness R` | §2.1 input | exposed bedrock |

Pack these into RGBA8 or RG16 textures for the renderer; at 2048², 4 RGBA8 maps = 64 MiB.

---

## 7. Shaping operators: terracing, canyons, coasts, snow, alluvial fans

These are all **post-erosion stylization** passes. They are cheap, single-pass, and they are what makes a
terrain look *authored* rather than *simulated*.

### 7.1 Terracing / strata

Naive `floor(h*n)/n` gives flat shelves with vertical risers and hard aliasing. The good version keeps a
controllable riser profile and disables itself on steep ground:

```wgsl
// n     : number of terraces over the full height range   [4 .. 64], default 16
// sharp : riser sharpness                                 [1 .. 8],  default 3
// amount: blend with the original                         [0 .. 1],  default 0.7
fn terrace(h: f32, n: f32, sharp: f32, amount: f32, slope01: f32) -> f32 {
  let s = h * n;
  let i = floor(s);
  let f = s - i;
  // pow-shaped riser: f^sharp pushes mass to the top of the step -> flat tread, steep riser
  let fp = pow(f, sharp);
  let terraced = (i + fp) / n;
  // don't terrace cliffs: real strata only show on moderate slopes
  let w = amount * (1.0 - smoothstep(0.55, 0.85, slope01));
  return mix(h, terraced, w);
}
```

Variants worth having:
* **Symmetric riser** (bevelled both ways): `fp = smoothstep(0,1,f)` raised to a power, or
  `fp = 0.5 + 0.5*sign(f-0.5)*pow(abs(2.0*f-1.0), sharp)`.
* **Non-uniform strata:** replace `h*n` with `stratumWarp(h)` where `stratumWarp` is a 1D noise/LUT →
  varying bed thickness, which reads as real sedimentary rock.
* **Tilted strata:** terrace `h + tilt·(dot(p, tiltDir))` instead of `h`, then subtract the tilt back.
  This produces dipping beds (mesa country, Zion/Canyonlands).
* **Regional terracing:** use the Worley cell id (§1.5, `id1`) to give each Voronoi region its own
  `n` and phase → plateaus at different heights.

### 7.2 Canyonize

Carve a canyon along the river network (§5.6) with a profile that depends on drainage area, and terrace
the walls.

```
for each cell:
  w   = w0 * sqrt(A / A_crit)                    # width in cells, §5.6
  dst = distance to nearest channel cell          # from a JFA distance field, §8.6
  t   = clamp(dst / w, 0, 1)
  depth = d0 * pow(A / A_crit, 0.35)
  profile = 1 - t*t                               # parabolic; use (1-t)^1.5 for a sharper gorge
  h -= depth * profile
  # walls: terrace only in the band [w, 3w] around the channel
  wallMask = smoothstep(1.0, 1.6, t) * (1.0 - smoothstep(2.5, 3.2, t))
  h = terrace(h, n, sharp, wallMask, slope01)
```
Then enforce downstream monotonicity (§5.6) and run 5–10 thermal passes (§3) so the canyon rim gets a
talus apron instead of a knife edge.

### 7.3 Coast / beach generation

Given sea level `S` (in normalized height units):

```wgsl
// 1. wave-cut platform: compress relief just above sea level
let above = h - S;
let platformW = 0.02;                 // height band affected
let k = 0.25;                         // compression factor (0 = fully flat bench)
let compressed = S + above * mix(k, 1.0, smoothstep(0.0, platformW, above));

// 2. beach: flatten to a shallow constant slope within a horizontal distance band
//    distToShore comes from a JFA distance field of the |h - S| = 0 contour (signed)
let beachW = 40.0;                    // cells
let beachSlope = 0.0006;              // height per cell
let tb = clamp(distToShore / beachW, 0.0, 1.0);
let beachTarget = S + sign(distToShore) * abs(distToShore) * beachSlope;
var hOut = mix(beachTarget, compressed, smoothstep(0.0, 1.0, tb));

// 3. cliffs where the pre-existing slope is high: skip the beach entirely
let cliff = smoothstep(0.30, 0.55, slope01);
hOut = mix(hOut, h, cliff);
```

Notes:
* Do the shoreline distance field on the **eroded** terrain, and recompute it after any carving.
* Underwater, run a couple of extra thermal passes with a **shallower talus angle** (sand, ~30°) —
  submarine slopes are gentler and this alone makes coasts read correctly.
* A cheap surf/foam mask for texturing: `foam = 1 - smoothstep(0, foamW, abs(h - S))`.

### 7.4 Snow / sediment settling

Snow is thermal erosion on a *second layer* with a low talus angle. Treat it as a real material:

```
1. deposit:  snow += rate * saturate((h - snowline)/fade)
                  * pow(saturate(dot(n, up)), p)      # p ~ 2..4: less on steep faces
                  * (0.6 + 0.4*sky)                   # §6.3: less under overhangs/in crevices
                  * (1.0 - 0.5*insolationNorm)        # §6.5: less on sun-facing slopes
2. settle:   run 10-30 thermal passes (§3.4) on `snow` with talus = tan(35 deg),
             using the COMBINED surface (h + snow) to compute slopes but moving only `snow`
3. combine:  hFinal = h + snow ;  snowMask = snow / maxSnow  -> texture blend weight
```
Same scheme works for a generic "loose sediment" layer: deposit where `planCurv > 0` and `slope` is low,
then settle with talus = 32°. This is by far the cheapest way to get convincing scree cones at the base
of cliffs.

### 7.5 Alluvial fans

An alluvial fan forms where a confined channel exits steep terrain onto a flat. Detect and splat:

```
detect: cells where  A > A_crit
                 AND slope(upstream window) > s_hi        # e.g. tan(15 deg)
                 AND slope(downstream window) < s_lo      # e.g. tan(3 deg)
        -> these are "fan apexes"
splat:  for each apex a with drainage area A_a:
          R  = R0 * sqrt(A_a / A_crit)                    # fan radius, cells
          H  = H0 * pow(A_a / A_crit, 0.25)               # apex thickness
          for cells p within R of a:
            r     = |p - a| / R
            theta = angle(p - a) vs the downstream flow direction
            lobe  = exp(-(theta/spread)^2)                # spread ~ 0.6 rad -> ~70 deg fan
            dh    = H * (1 - r)^2 * lobe
            h[p] += dh
```
Then a few thermal passes to blend the toe. Keep `H0` small (a few metres) — real fans are subtle in
height but very obvious in *texture*, so also write the fan mask into your sediment/sand map.

**Implementation note:** apexes are sparse (tens to hundreds). Collect them on CPU (or via an
`atomicAdd`-built append buffer on GPU) and splat with one instanced dispatch per apex, or a single
dispatch over a bounding-box list. Do **not** loop over all apexes per pixel.

---

## 8. Constraint-driven shaping for gameplay ("Layout Generator")

The core idea: keep a **target field** `T(x,y)` and a **weight field** `W(x,y) ∈ [0,1]`, and at the end of
(and between) simulation stages apply

```wgsl
h = mix(h, T, W);
```

Everything below is a way of *producing* `(T, W)`. Because both are just textures, all constraints
compose: accumulate `T` weighted by `W` in a premultiplied buffer.

```wgsl
// premultiplied accumulation so overlapping constraints blend sanely
// acc.xyz unused, acc.w = sum of weights ; num = sum of w*T
num += w * t;
den += w;
// resolve:
T = num / max(den, 1e-6);
W = clamp(den, 0.0, 1.0);
```

### 8.1 Flattening under a mask

```
T = targetHeight                   # explicit, OR the mean/median of h under the mask
W = feather(maskSDF)
```
Computing the **mean under a mask** requires a reduction (§9.5): `sum(h·m)/sum(m)`. Using the *median*
(or the 40th percentile) instead of the mean is better for build pads — the mean is dragged up by any
spike inside the mask. Compute a percentile with a 256-bin histogram (`atomicAdd` on
`array<atomic<u32>,256>` in workgroup memory, then a prefix scan).

### 8.2 Plateau creation

```
T(p)    = plateauHeight
W(p)    = 1                                        inside the core region (d < r0)
        = smoothstep(1,0, (d-r0)/(r1-r0))          in the skirt (r0 <= d <= r1)
        = 0                                        outside
```
with `d` the SDF distance to the plateau polygon. **Add a rim:** `T += rimHeight * bump((d-r0)/(r1-r0))`
where `bump(t) = 4t(1-t)` — real mesas have a slight raised lip from differential erosion, and it
prevents the "pancake dropped on the terrain" look.

**Do not** apply a plateau with `W = 1` and a hard edge, then erode: the erosion will attack the vertical
wall and smear it. Either (a) apply before erosion with a wide skirt and re-apply after, or (b) mark
plateau cells as `hardness R = 1` so erosion leaves them alone.

### 8.3 Ramp carving between plateaus

Given plateaus at heights `hA`, `hB` and a **spline** `C(t)` (polyline or Catmull-Rom) connecting them:

```
for each pixel p:
  (t, d) = closestPointOnSpline(C, p)       # t = arclength parameter in [0,1], d = distance
  if d > rampHalfWidth + feather: skip
  target  = mix(hA, hB, smoothstep(0.0, 1.0, t))         # smoothstep = eased grade, no kinks at the ends
  # optional crown / banking:
  u = clamp(d / rampHalfWidth, 0, 1)
  target += crown * (1.0 - u*u)                          # convex road surface, drains water
  w = 1.0 - smoothstep(rampHalfWidth, rampHalfWidth + feather, d)
  accumulate (target, w)
```

**Grade check.** A ramp is only useful if units can climb it. With `L` world units per cell and the
normalized height range `HR`:
```
maxGrade = |hB - hA| * HR / (splineLength * L)
```
Assert `maxGrade <= maxClimbSlope` (e.g. `tan(25°) = 0.466` for most RTS units); if it fails, either
lengthen the spline (add a switchback control point) or reduce the height delta. Doing this check at
*layout* time, not after rasterization, is what makes a layout generator actually usable.

**Switchbacks:** generate them by inserting control points that alternate ±90° from the direct A→B
direction at regular arc intervals, then clamping the per-segment grade.

### 8.4 Symmetry enforcement

For competitive maps, symmetry must be **exact** (bit-exact after quantization), which means you must
enforce it *after* all floating-point work, on the quantized values, or with an exactly-symmetric sampling
pattern.

| Kind | Mapping `p → p'` (grid coords, `N×N`) |
|---|---|
| mirror X | `(N-1-x, y)` |
| mirror Y | `(x, N-1-y)` |
| mirror diagonal | `(y, x)` |
| point / 180° rotation | `(N-1-x, N-1-y)` |
| rotational k-fold | rotate `(x,y)` about the centre by `2πj/k`, `j=1..k-1` (needs bilinear sampling — only exact for k ∈ {2,4} on a square grid) |
| translational (k lanes) | `(x + j·N/k mod N, y)` |

```wgsl
// exact 2-fold / 4-fold symmetrization: every orbit gets ONE representative value
@compute @workgroup_size(8,8)
fn symmetrize(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = i32(P.N); let x = i32(gid.x); let y = i32(gid.y);
  if (x >= n || y >= n) { return; }
  var acc = 0.0; var cnt = 0.0;
  for (var j = 0u; j < P.orbitSize; j = j + 1u) {
    let q = orbitMap(vec2<i32>(x,y), j, n);            // exact integer permutation
    acc = acc + hIn[u32(q.y*n + q.x)]; cnt = cnt + 1.0;
  }
  hOut[u32(y*n + x)] = acc / cnt;                       // mean over the orbit -> exactly symmetric
}
```
Averaging over the orbit (rather than copying one half) preserves more of the eroded detail and avoids a
visible seam. For `k = 4` rotational on a square grid, use the integer permutation
`(x,y) → (y, N-1-x)` and its powers — all exact, no resampling.

**Seam handling:** a mirrored map has a mirror axis where `∂h/∂x = 0` by construction — water will not
cross it, so rivers pool along the seam. Fix by (a) tilting the whole map slightly so the seam drains,
or (b) placing the seam along a ridge line deliberately, or (c) breaking symmetry in a narrow band
(± 8 cells) with a low-amplitude asymmetric noise **after** the drainage-critical passes.

**Erosion and symmetry do not commute.** Droplet erosion is stochastic → never symmetric. Either
(a) simulate only the fundamental domain and mirror afterwards (cheapest, exact), or
(b) symmetrize the droplet spawn positions, or (c) simulate everything and symmetrize at the end
(loses some detail coherence at the seam, but is fine in practice).

### 8.5 Feathered mask blending

```wgsl
// SDF-driven feather: d < 0 inside
fn feather(d: f32, w: f32) -> f32 { return 1.0 - smoothstep(-w*0.5, w*0.5, d); }
```
* `smoothstep` (C¹) is fine for height blends. For anything you will differentiate (normals, curvature)
  use the **smootherstep** quintic `t³(6t²−15t+10)` — a `smoothstep` edge shows a visible crease in the
  normal map.
* Feather width should be **at least 4–8 cells**; below that you get a visible ring.
* For a *non-blurring* blend that preserves detail, mix the **difference**, not the absolute height:
  `h = h + W * (T - blur(h, featherRadius))` — this drops the low frequency toward the target while
  leaving the high-frequency detail intact. This is the "flatten but keep the texture" operator, and it
  is the one you actually want for build pads.

### 8.6 Distance fields from splines and masks

Three options, in order of increasing size:

1. **Brute force per-pixel over tessellated segments.** Tessellate every spline into segments; for each
   pixel loop all segments computing point-segment distance. `O(N² · S)`. Fine for `S ≤ ~2000` at 1024²
   (2 G ops ≈ 30 ms). Put segments in a storage buffer; use a workgroup-shared cache of 256 segments at a
   time.
   ```wgsl
   fn sdSegment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
     let pa = p - a; let ba = b - a;
     let t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
     return length(pa - ba * t);
   }
   ```
   (Also return `t` and the segment's cumulative arc length to get the global spline parameter — you
   need it for ramps, §8.3.)
2. **Jump Flooding Algorithm (JFA)** — Rong & Tan 2006. `O(N² log N)` total, `log2(N)` dispatches:
   seed each feature pixel with its own coordinate, then for `k = N/2, N/4, …, 1` each pixel samples its
   8 neighbours at offset `k` and keeps the closest seed. Gives an approximate (>99.9 % exact) Voronoi +
   distance field for arbitrary masks, not just splines. **This is the general-purpose answer** — use it
   for shoreline distance, river distance, plateau SDFs, everything.
   Storage: `rg32float` (seed coords) or `rg16uint` if `N ≤ 65535`. Run `1+JFA` (an extra pass at k=1) to
   clean up the rare errors.
3. **Exact Euclidean DT (Felzenszwalb & Huttenlocher 2004)** — two separable 1D lower-envelope passes,
   `O(N²)` exact. Sequential per row/column, so on GPU it is one thread per row then one per column
   (`N` threads — underutilizes a GPU at N=1024 but is still ~1 ms). Use when you need *exact*.

**Signed** distance: compute the DT of the inside and of the outside, subtract.

### 8.7 Spline-based ridge / river layout — the Layout Generator

Data model:

```ts
type NodeKind = 'peak' | 'saddle' | 'basin' | 'spawn' | 'resource' | 'junction';
interface LayoutNode {
  id: number; pos: [number, number];        // normalized [0,1]^2
  kind: NodeKind;
  height: number;                            // normalized target elevation
  radius: number;                            // influence radius, normalized
  hardness?: number;                         // 0..1 -> writes the R field (§2.1)
  flat?: boolean;                            // build pad
}
interface LayoutEdge {
  a: number; b: number;
  kind: 'ridge' | 'river' | 'ramp' | 'road';
  ctrl: [number, number][];                  // Catmull-Rom control points
  width: number;                             // normalized
  strength: number;                          // 0..1 blend weight
}
```

Rasterization order (each writes into the premultiplied `(num, den)` accumulator of §8):

```
1. NODES  -> radial primitives:
     peak   : T = node.height, profile = (1-r^2)^2          (smooth dome, C1 at the edge)
     basin  : T = node.height, profile = -(1-r^2)           (bowl)
     flat   : T = node.height, profile = 1 inside r0, feathered to r1
   Combine multiple overlapping nodes with a SMOOTH MAX, not a sum:
     smax(a,b,k) = max(a,b) + log(1 + exp(-|a-b|/k)) * k     # k ~ 0.05 * heightRange
   (a plain sum makes two nearby peaks add into one absurdly tall one)

2. RIDGE EDGES -> for each pixel, (t, d) = closestPointOnSpline
     crestH = interpolate node heights along t (monotone cubic, so no overshoot)
     T      = crestH - ridgeDrop * (d / width)^1.4          # 1.4 exponent = concave flanks
     W      = strength * (1 - smoothstep(width, width*2, d))
   Ridge splines should be MONOTONE in height between saddles, or you create unintended basins.

3. RIVER EDGES -> same, but:
     T = channelH(t) - depth * (1 - (d/width)^2)
     channelH(t) must be STRICTLY DECREASING downstream (enforce with a prefix-min pass)
     also write a "rivermask" and a "hardness = 0.2" (soft) into R so erosion follows the route

4. RAMPS -> §8.3
5. noise-perturb the splines before rasterizing:
     p_spline += warpAmp * vec2(fbm(t*freq, s1), fbm(t*freq, s2))
   with warpAmp ~ 0.3 * width. Without this, the layout reads as obviously hand-drawn.
```

Then: `h = mix(noiseBase, T, W)` → erosion (§2,§3) → **re-apply** the gameplay-critical subset
(flat pads, ramps) with a narrower feather → derived maps.

**Validation pass (do this, it pays for itself):**
```
- connectivity: flood-fill from each spawn over cells with slope < maxClimbSlope;
  assert every spawn reaches every other spawn and every resource node.
- pad flatness: max|h - mean(h)| inside each flat node < tolerance (e.g. 0.5 m).
- symmetry: assert the quantized uint16 map equals its own symmetrized version, exactly.
- no unintended basins: run priority-flood (§5.4) and assert no filled depression exceeds
  a volume threshold outside of declared 'basin' nodes.
```
All four are cheap GPU reductions or a single CPU pass, and they turn "looks nice" into "is playable".

---

## 9. GPU practicalities in WebGPU

All limits below are the **defaults** from [WebGPU §3.6.2 "Limits"](https://www.w3.org/TR/webgpu/#limits),
and all format capabilities from [WebGPU §26.1.1 "Plain color formats"](https://www.w3.org/TR/webgpu/#plain-color-formats).

### 9.1 Storage buffers vs storage textures — the decision that matters

> **Recommendation: keep the heightfield in a `storage buffer` of `f32`, not a storage texture.**

Reasons:
1. **`var<storage, read_write>` is core WebGPU.** Read-write *storage textures* are **not** core: they
   require the WGSL language extension `readonly_and_readwrite_storage_textures`
   ([WGSL §4.1.2 "Language Extensions"](https://www.w3.org/TR/WGSL/#language-extensions), which also adds
   `textureBarrier`), and even then `read_write` access is permitted only for `r32uint`, `r32sint`,
   `r32float`. Detect with `navigator.gpu.wgslLanguageFeatures.has('readonly_and_readwrite_storage_textures')`
   and declare `requires readonly_and_readwrite_storage_textures;` at the top of the shader.
2. **Atomics require a storage buffer.** `atomic<T>` may only be instantiated *"by variables in the
   workgroup address space or by storage buffer variables with a read_write access mode"*
   ([WGSL §6.4.5](https://www.w3.org/TR/WGSL/#atomic-types)) — and `T` must be `u32` or `i32`. There are
   **no texture atomics and no float atomics** in WGSL. Droplet erosion (§2.2) and flow accumulation
   (§5.3c) both need atomics → buffer.
3. `maxStorageTexturesPerShaderStage` default is **4**; `maxStorageBuffersPerShaderStage` default is
   **8**. The pipe model needs ~6 bindings.
4. Buffers have no format conversion, no clamping, and a trivially predictable layout.

Use **textures** when you specifically want: hardware **bilinear** sampling (semi-Lagrangian advection!),
mipmaps (AO cone-marching, multi-scale schedules), or clamp-to-edge addressing for free.

**`r32float` capability matrix (current spec, §26.1.1):** `RENDER_ATTACHMENT` ✓;
`STORAGE_BINDING` write-only ✓, read-only ✓, read-write ✓; **sample type is `"unfilterable-float"`**
unless the `float32-filterable` feature is enabled. That last point is the trap:

> **GOTCHA:** you cannot `textureSample()` an `r32float` texture with a linear filter unless the adapter
> supports and the device requests the **`float32-filterable`** feature. Without it you must either
> (a) request the feature, (b) use `r16float` (filterable by default, but only ~3 decimal digits of
> mantissa — too coarse for heights, fine for velocity/sediment), or (c) do your own bilinear with
> 4 × `textureLoad`. For semi-Lagrangian advection, (c) is ~4 taps and totally fine.

### 9.2 Ping-pong

Nothing in WebGPU lets you safely read and write the same buffer region from different invocations within
one dispatch unless you use atomics or `read_write` textures + `textureBarrier`. So: **two buffers, swap
the bind group.**

```ts
const bufs = [makeStorage(bytes), makeStorage(bytes)];
const bindGroups = [makeBG(bufs[0], bufs[1]), makeBG(bufs[1], bufs[0])];
let src = 0;
for (let i = 0; i < iterations; i++) {
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bindGroups[src]);
  pass.dispatchWorkgroups(wgX, wgY);
  pass.end();
  src ^= 1;
}
```
Two pre-built bind groups, zero per-iteration allocation. Do **not** create bind groups in the loop —
that is the number-one cause of a WebGPU compute loop being CPU-bound.

**Barriers are implicit** between dispatches in WebGPU: consecutive `dispatchWorkgroups` calls in the
same compute pass are ordered and the implementation inserts the necessary memory barriers for resources
used by both. You do **not** need (and cannot express) an explicit global barrier inside a dispatch.

**Fields you can update in place** (no ping-pong needed) are those written only by the owning cell:
in the pipe model, `b` and `s` in the erosion/deposition pass, and the flux buffer if you write `fOut`
only at your own index. Ping-pong is needed for `d` (neighbour gather) and for the advection of `s`.

### 9.3 Workgroup sizing

* **Start with `@workgroup_size(8, 8)`** = 64 invocations for 2D stencil work. It maps to 2 AMD wavefronts
  / 2 NVIDIA warps, gives a 2D tile shape with good cache locality, and leaves headroom for workgroup
  memory.
* `@workgroup_size(16, 16)` = 256 = `maxComputeInvocationsPerWorkgroup` (default). Legal, but it is the
  *maximum*, so any workgroup-memory usage may cut occupancy. Measure.
* **1D passes** (droplets, reductions): `@workgroup_size(64)` or `@workgroup_size(256)`.
* **Compatibility mode** lowers `maxComputeInvocationsPerWorkgroup` and `maxComputeWorkgroupSizeX/Y` to
  **128**. If you might run in compat mode, cap at `(8,8)` or `(128,1)`.
* `maxComputeWorkgroupSizeZ` = **64**; `maxComputeWorkgroupStorageSize` = **16384 bytes** (so at most
  4096 `f32`s of `var<workgroup>`, e.g. a 64×64 f32 tile exactly fills it).
* `maxComputeWorkgroupsPerDimension` = **65535**.
* **Always bounds-check**: `if (x >= N || y >= N) { return; }` — the dispatch is rounded up.
* WGSL requires the workgroup size to be a **const-expression**; use a pipeline-overridable constant if
  you want to tune at runtime:
  ```wgsl
  override WG_X: u32 = 8u;
  override WG_Y: u32 = 8u;
  @compute @workgroup_size(WG_X, WG_Y) fn main(...) { ... }
  ```

**Shared-memory tiling for stencils.** For a 3×3 stencil at `(8,8)`, a naive version does 9 global loads
per cell; a tiled version loads a `10×10` halo into `var<workgroup>` (100 loads for 64 cells = 1.56/cell).
Worth it for multi-pass thermal erosion; measure before adding the complexity — on modern GPUs the L1/L2
often makes the naive version just as fast.

### 9.4 Atomics: what you can and cannot do

| Want | WGSL support | Workaround |
|---|---|---|
| `atomicAdd` on `u32`/`i32` in a storage buffer | ✅ core | — |
| `atomicAdd` on `f32` | ❌ | **fixed point**: `atomicAdd(&a[i], i32(round(v * 1048576.0)))` (2^20 scale) |
| `atomicMax` on `f32` | ❌ | monotonic bit trick, below |
| any atomic on a texture | ❌ | use a buffer |
| `atomicAdd` in the `uniform` address space | ❌ | storage only |
| 64-bit atomics | ❌ | split into hi/lo with a CAS loop (painful; avoid) |

**Float ordering trick** (lets you use `atomicMax`/`atomicMin` on `u32` for floats):
```wgsl
// Maps IEEE-754 f32 to u32 preserving order (including negatives).
fn f32_to_orderedU32(f: f32) -> u32 {
  let b = bitcast<u32>(f);
  return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u);
}
fn orderedU32_to_f32(u: u32) -> f32 {
  // high bit set -> came from a positive float ; clear -> came from a negative float
  let b = select(~u, u & 0x7FFFFFFFu, (u & 0x80000000u) != 0u);
  return bitcast<f32>(b);
}
```
Round-trip is exact for all finite values including `-0.0`. Use `atomicMax` on the ordered key, then
decode once at the end.

**Fixed-point precision budget.** With a `2^20` scale and `i32`, the representable range is
`±2^31/2^20 = ±2048` height units with a resolution of `9.5e-7`. For a `[0,1]` normalized heightfield
that is ~20 bits of fraction — ample. If you need more headroom, use `2^16` (range ±32768, resolution
1.5e-5).

### 9.5 Multi-pass reductions (min/max/sum)

Needed for: height normalization, `Σ|Δh|` convergence tests, mask means (§8.1), histogram percentiles.

**Two-stage tree reduction** — the standard, portable, deterministic-enough pattern:

```wgsl
const WG: u32 = 256u;
var<workgroup> sdata: array<vec2<f32>, WG>;             // (min, max)

@group(0) @binding(0) var<storage, read>       src : array<f32>;
@group(0) @binding(1) var<storage, read_write>  dst : array<vec2<f32>>;   // one entry per workgroup

@compute @workgroup_size(256)
fn reduceMinMax(@builtin(global_invocation_id) gid: vec3<u32>,
                @builtin(local_invocation_index) lid: u32,
                @builtin(workgroup_id) wid: vec3<u32>) {
  // grid-stride load: each thread folds several elements first (4x fewer workgroups)
  var mn =  3.4e38; var mx = -3.4e38;
  var i = gid.x;
  let stride = P.totalThreads;
  loop {
    if (i >= P.count) { break; }
    let v = src[i];
    mn = min(mn, v); mx = max(mx, v);
    i = i + stride;
  }
  sdata[lid] = vec2<f32>(mn, mx);
  workgroupBarrier();

  var s = WG / 2u;
  loop {
    if (s == 0u) { break; }
    if (lid < s) {
      sdata[lid] = vec2<f32>(min(sdata[lid].x, sdata[lid+s].x),
                             max(sdata[lid].y, sdata[lid+s].y));
    }
    workgroupBarrier();
    s = s >> 1u;
  }
  if (lid == 0u) { dst[wid.x] = sdata[0]; }
}
```
Dispatch 1: `ceil(N²/(256·4))` workgroups → that many partials. Dispatch 2: the same kernel over the
partials → 1 value (or recurse until ≤ 256). Two dispatches suffice up to `256·4·256·4 = 1.05 M`… for
`N = 4096` (16.8 M) you need three levels, or raise the grid-stride factor. **Rule: `levels =
ceil(log_{1024}(N²))`** with WG=256 and 4 elements/thread.

Alternatives:
* **Single-pass with atomics:** `atomicMax` on the ordered-u32 encoding (§9.4). One dispatch, but
  contention on one word; fine for min/max (few updates survive), bad for sum.
* **Subgroups** (`subgroupAdd`, `subgroupMax`) — the `"subgroups"` feature. ~2× faster reductions but
  not universally available; feature-detect and keep the workgroup path as a fallback.
* **Never read back per-iteration.** `mapAsync` + `await` stalls the whole pipeline. Reduce into a GPU
  buffer, read back only every K iterations (or use the result directly in the next shader via a
  uniform-free storage read).

### 9.6 Sorting on GPU (for §5.3b, §5.4)

If you need cells sorted by height: **radix sort on the ordered-u32 key** (§9.4), 4 passes of 8 bits,
each pass = histogram + prefix-scan + scatter. ~1–2 ms at 4 M elements. In practice: for a one-shot
pipeline, do it on CPU in TypeScript with a `Uint32Array` radix sort (~200 ms at 4 M) and skip the
complexity. Priority-flood needs a real priority queue and is sequential — keep it on CPU.

### 9.7 Timing and profiling

* Request the **`"timestamp-query"`** feature; `pass.writeTimestamp` is gone from the current API —
  use `GPUComputePassDescriptor.timestampWrites = { querySet, beginningOfPassWriteIndex,
  endOfPassWriteIndex }`. Resolve into a buffer, copy to a `MAP_READ` buffer, read once per second.
* Without the feature, wrap `device.queue.onSubmittedWorkDone()` — coarse but enough to find the pass
  that costs 200 ms.
* Measure with the **same dispatch you ship**: shader compilation happens on first use; run 3 warm-up
  iterations.

### 9.8 Long-running work and the watchdog

A single dispatch that runs for seconds will be killed by the OS/driver TDR (2 s on Windows) and
`device.lost` will fire. **Always tile long work:**

```ts
// Split an expensive per-pixel pass (AO, insolation) into row bands, one submit per band,
// yielding to the event loop between submits so the page stays responsive.
for (let band = 0; band < bands; band++) {
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(aoPipe);
  pass.setBindGroup(0, bg);
  pass.setBindGroup(1, bandBG[band]);             // uniform: yOffset, yCount
  pass.dispatchWorkgroups(wgX, bandWgY);
  pass.end();
  device.queue.submit([enc.finish()]);
  await new Promise(r => setTimeout(r, 0));       // let the browser breathe / update progress UI
}
```
Target **≤ 16 ms per submit** if you want a live preview, ≤ 200 ms if you only need a progress bar.

Also: handle `device.lost` and rebuild everything. It *will* happen on someone's Intel iGPU.

### 9.9 WebGL2 fallback

WebGL2 has **no compute shaders, no storage buffers, no atomics**. What survives:

| Capability | WebGL2 | How |
|---|---|---|
| float render target | ✅ *if* `EXT_color_buffer_float` | `gl.getExtension('EXT_color_buffer_float')`; then `R32F`/`RGBA32F` are renderable |
| linear filtering of float | ⚠️ needs `OES_texture_float_linear` | otherwise do 4-tap manual bilinear |
| half-float render target | ✅ (`EXT_color_buffer_half_float`, widely available) | `RGBA16F`; 10-bit mantissa — **not enough for heights** |
| multiple render targets | ✅ core (up to `MAX_DRAW_BUFFERS`, ≥ 4, usually 8) | `gl.drawBuffers([...])` — lets one fullscreen pass write `d`, `f`, `v` at once |
| ping-pong | ✅ | two FBOs, swap |
| gather/stencil reads | ✅ | `texelFetch` |
| **scatter** (droplet erosion) | ⚠️ emulated | draw `GL_POINTS`, one vertex per droplet, with `gl_Position` computed in the **vertex shader** and `blendFunc(ONE, ONE)` additive blending into a float target. This is the classic scatter trick and it does work. |
| reductions | ✅ | mip-chain reduction: render to successively halved targets with a 2×2 `max`/`min`/`sum` shader; `log2(N)` passes |
| transform feedback | ✅ | keeps droplet state (pos, vel, water, sediment) across steps without CPU round-trips |
| sorting / priority queue | ❌ | do it on CPU |
| exact determinism | ⚠️ | additive blending is order-dependent on ties; f32 blending is not guaranteed associative |

**Infeasible in WebGL2 (do on CPU or drop):** priority-flood depression filling, radix sort, topological
flow accumulation, histogram percentiles, anything needing atomics. Everything else (noise, pipe model,
thermal, derived maps, quantization) maps to fullscreen-quad fragment passes with MRT almost 1:1 —
the pipe model in particular was *designed* for this (Mei et al. 2007 targeted Shader Model 3.0 with
7 fragment passes, §2.1).

**Practical fallback plan:** WebGL2 path = noise + pipe model + thermal + derived maps + quantization,
all as fragment passes; flow accumulation via the iterative-relaxation scheme (§5.3d, it is a pure gather
→ works); depression filling and validation on the CPU. Expect ~3–5× slower than WebGPU and cap the
resolution at 2048².

---

## 10. Precision: f32 in the pipeline, uint16 at the door

### 10.1 Why f32 internally

IEEE-754 binary32 has a 24-bit significand. The gap between representable values (ULP) is:

| magnitude | ULP |
|---|---|
| 1.0 | `1.19e-7` |
| 16.0 | `1.91e-6` |
| 1024.0 | `1.22e-4` |
| 4096.0 | `4.88e-4` |

Erosion accumulates **many tiny increments**. A pipe-model step with `Ks = 0.5`, `Δt = 0.02` and a small
capacity deficit produces `Δb ≈ 1e-5` to `1e-7` per iteration. If you store heights in metres
(`h ≈ 1000`), the ULP is `1.22e-4` — **larger than the per-step delta**, so the addition is a no-op and
erosion silently stops on high ground while working fine in valleys. The bug looks like "my mountains
won't erode".

> **Rule: simulate in normalized units (`h ∈ [0,1]`), convert to world metres only at export.**
> At `h ≈ 1`, ULP is `1.19e-7` — three orders of magnitude of headroom below the smallest step.

Other precision rules:
* **f16 is not an option** for heights: 11-bit significand → ULP at 1.0 is `9.8e-4`. Fine for velocity,
  flux and sediment; never for `b`.
* **Accumulate deltas separately** when summing many contributions (droplet brushes): accumulate into a
  per-cell `delta` buffer and add once, rather than N read-modify-writes on `h`. Halves the rounding
  error and is friendlier to fixed-point atomics.
* **Kahan summation** is unnecessary here; the per-cell contributions are few and similar in magnitude.
* Keep `heightRange` (`maxHeight − minHeight`) fixed and known *before* simulating, so you can convert
  parameters (talus thresholds, depths) between normalized and world units consistently.

### 10.2 Quantization to uint16

```
u = round( (h_world - minHeight) / (maxHeight - minHeight) * 65535 )
h_world = minHeight + (u / 65535) * (maxHeight - minHeight)
```

**Step size** `q = (maxHeight − minHeight) / 65535`.

Worked example (a Recoil/Spring SMF target, see §10.4): `minHeight = −200`, `maxHeight = 800`
→ range 1000 elmos → `q = 1000 / 65535 = 0.0152590` elmos per LSB.

**When does banding appear?** A slope produces a visible terrace whenever the height change across one
cell is smaller than one quantization step:
```
terraceWidth_cells = q / (slope * cellSize)
```
With `q = 0.015259`, `cellSize = 8` elmos:

| slope | Δh per cell | terrace width |
|---|---|---|
| 0.10 (5.7°) | 0.80 | 0.02 cells → invisible |
| 0.01 (0.57°) | 0.080 | 0.19 cells → invisible |
| 0.001 (0.06°) | 0.0080 | **1.9 cells → visible bands** |
| 0.0002 | 0.0016 | **9.5 cells → obvious terraces** |

So: **beaches, lake beds, plains and build pads band; mountains never do.** Which is exactly where players
look. Hence dithering.

### 10.3 Dithering the quantization

Add a sub-LSB offset before rounding so the *average* of the quantized surface tracks the true surface,
converting a coherent terrace into incoherent noise.

**Preferred: triangular-PDF (TPDF) dither.** Two independent uniforms give a triangular distribution over
`(−1, +1)` LSB, which makes the quantization error **independent of the signal** (no noise modulation —
with a single uniform (RPDF), the error's variance pumps with the signal and you can still see the
terraces as bands of changing grain).

```ts
// TypeScript export path
function quantizeTPDF(h01: Float32Array, out: Uint16Array, rng: () => number) {
  for (let i = 0; i < h01.length; i++) {
    const d = rng() - rng();                        // TPDF in (-1, 1), variance 1/6
    const v = h01[i] * 65535 + d * 0.5;             // +/- 0.5 LSB
    out[i] = Math.max(0, Math.min(65535, Math.round(v)));
  }
}
```

```wgsl
// GPU version, blue-noise driven (better than white noise: the error energy sits at high frequency
// where the eye and any downstream filtering both reject it)
fn quantize16(h01: f32, p: vec2<u32>) -> u32 {
  let b1 = textureLoad(blueNoise, vec2<i32>(p % 64u), 0).r;                 // [0,1)
  let b2 = textureLoad(blueNoise, vec2<i32>((p + vec2<u32>(37u,17u)) % 64u), 0).r;
  let d  = (b1 - b2) * 0.5;                                                  // TPDF, +/- 0.5 LSB
  return u32(clamp(round(h01 * 65535.0 + d), 0.0, 65535.0));
}
```

**Alternative: Floyd–Steinberg error diffusion** (CPU only — inherently sequential):
```
err = v - round(v)
distribute:  (x+1,y) += err*7/16 ; (x-1,y+1) += err*3/16 ; (x,y+1) += err*5/16 ; (x+1,y+1) += err*1/16
```
Best DC accuracy (error is *conserved*, not just decorrelated) but produces a faint diagonal worm texture
and cannot be parallelized. **Use TPDF blue-noise on GPU**; use Floyd–Steinberg only if you can measure a
difference (you usually cannot, at 16 bits).

**What NOT to do:**
* Do not dither with amplitude > 1 LSB: you are adding real noise to the terrain, which shows up in
  normals and AO as sparkle. Normals are computed from *differences* of neighbouring heights, so ±0.5 LSB
  of independent noise becomes ±1 LSB of gradient noise — at `q/cellSize = 0.015/8 = 0.0019` slope units
  that is invisible, but if you double the dither or shrink the cell size it will not be.
* Do not dither *before* any further processing (smoothing, symmetry checks, hashing). Quantize+dither is
  strictly the **last** step.
* Do not `floor()` instead of `round()` — it introduces a systematic −0.5 LSB bias, which on a 1000 m
  range is a uniform 7.6 mm drop. Harmless alone, but it breaks exact-symmetry assertions and round-trip
  tests.
* If you must preserve **exact symmetry** (§8.4): symmetrize the **dither pattern** too (make the blue
  noise lookup symmetric under the same orbit map), or dither only the fundamental domain and mirror the
  uint16 result.

**Optional: post-quantization verification.**
```
maxErr = max |dequant(quantize(h)) - h|     # must be <= 0.5 LSB without dither, <= 1.0 LSB with TPDF
meanErr = mean(dequant(quantize(h)) - h)    # must be ~0 (|meanErr| < 0.01 LSB); a nonzero mean means
                                            # you used floor() or a one-sided dither
```

### 10.4 Export target reference (Recoil / Spring SMF)

Since the uint16 decision is usually forced by the engine, here is the exact target, quoted from
`rts/Map/SMF/SMFFormat.h` in <https://github.com/beyond-all-reason/RecoilEngine>:

**`struct SMFHeader`** (`SMFFormat.h:49–70`), packed C layout, little-endian, **80 bytes total**
**[offsets derived from the quoted field order and types]**:

| Offset | Size | Type | Field | Source line | Semantics (verbatim comment) |
|---:|---:|---|---|---:|---|
| 0 | 16 | `char[16]` | `magic` | 50 | `"spring map file\0"` |
| 16 | 4 | `int` | `version` | 51 | "Must be 1 for now" |
| 20 | 4 | `int` | `mapid` | 52 | "Sort of a GUID of the file, just set to a random value when writing a map" |
| 24 | 4 | `int` | `mapx` | 54 | "Must be divisible by 128" |
| 28 | 4 | `int` | `mapy` | 55 | "Must be divisible by 128" |
| 32 | 4 | `int` | `squareSize` | 56 | "Distance between vertices. Must be 8" |
| 36 | 4 | `int` | `texelPerSquare` | 57 | "Number of texels per square, must be 8 for now" |
| 40 | 4 | `int` | `tilesize` | 58 | "Number of texels in a tile, must be 32 for now" |
| 44 | 4 | `float` | `minHeight` | 59 | "Height value that 0 in the heightmap corresponds to" |
| 48 | 4 | `float` | `maxHeight` | 60 | "Height value that 0xffff in the heightmap corresponds to" |
| 52 | 4 | `int` | `heightmapPtr` | 62 | "File offset to elevation data (short int[(mapy+1)*(mapx+1)])" |
| 56 | 4 | `int` | `typeMapPtr` | 63 | "File offset to typedata (unsigned char[mapy/2 * mapx/2])" |
| 60 | 4 | `int` | `tilesPtr` | 64 | "File offset to tile data (see MapTileHeader)" |
| 64 | 4 | `int` | `minimapPtr` | 65 | "File offset to minimap (always 1024*1024 dxt1 compressed data plus 8 mipmap sublevels)" |
| 68 | 4 | `int` | `metalmapPtr` | 66 | "File offset to metalmap (unsigned char[mapx/2 * mapy/2])" |
| 72 | 4 | `int` | `featurePtr` | 67 | "File offset to feature data (see MapFeatureHeader)" |
| 76 | 4 | `int` | `numExtraHeaders` | 69 | "Numbers of extra headers following main header" |
| **80** | | | *(end of header; `ExtraHeader{int size; int type;}` records follow)* | 85–88 | |

Other exact constants from the same file:
* `SMALL_TILE_SIZE = (512>>0)+(512>>2)+(512>>4)+(512>>6)` = **680** bytes/tile (`SMFFormat.h:28`;
  confirmed by the comment at line 173: *"exactly SMALL_TILE_SIZE (680) bytes per tile (512 + 128 + 32 + 8)"*).
* `MINIMAP_NUM_MIPMAP = 9` (`:31`), `MINIMAP_SIZE = 699048` bytes (`:34`).
  Check: DXT1 at 1024²=524288, +512²=131072, +256²=32768, +128²=8192, +64²=2048, +32²=512, +16²=128,
  +8²=32, +4²=8 → **699048** ✓.

**Worked size calculation — a "16×16" map** (16 × 64 = 1024 heightmap squares per side):

```
mapx = mapy = 1024                       (divisible by 128 ✓)
squareSize = 8  ->  world size = 1024 * 8 = 8192 elmos per side
heightmap  = (mapx+1) * (mapy+1) = 1025 * 1025 = 1,050,625 uint16
           = 2,101,250 bytes = 2.004 MiB
typemap    = (mapx/2) * (mapy/2) = 512 * 512   =   262,144 bytes
metalmap   = (mapx/2) * (mapy/2) = 512 * 512   =   262,144 bytes
minimap    = 699,048 bytes
header     = 80 bytes (+ 8 bytes per ExtraHeader)
```

> **The `+1` matters.** The heightmap is `(mapx+1) × (mapy+1)` — **vertex**-centred, not cell-centred.
> Your simulation grid should therefore be `N = 1025`, or you simulate at `1024` and resample. If you
> simulate at a power of two and then just write `1025²` by clamping the last row/column, the map has a
> visible 1-cell-wide flat strip along two edges. Either simulate at `2^k + 1` throughout (diamond-square
> style) or upsample properly.

With `minHeight = -200`, `maxHeight = 800`: step `q = 1000/65535 = 0.015259` elmos, i.e. about
**1.5 cm** — far finer than the 8-elmo horizontal spacing, so vertical quantization is never the visual
bottleneck **except** on near-flat ground (§10.2), where you dither.

---

## 11. Appendix

### 11.1 Default parameter cheat sheet

```
NOISE          octaves 8, lacunarity 2.0 (or 1.98), gain 0.5 (H=1.0),
               rotate 36.87 deg between octaves, quintic interpolant
RIDGED MF      H 1.0, lacunarity 2.0, offset 1.0, gain 2.0, octaves 8
SWISS          lacunarity 2.0, gain 0.5, warp 0.15
JORDAN         lacunarity 2.0, gain1 0.8, gain 0.5, warp0 0.4, warp 0.35,
               damp0 1.0, damp 0.8, damp_scale 1.0
WARP           single warp, amplitude ~0.3 x base wavelength

PIPE EROSION   dt 0.02, A 20, g 9.81, l 1, Kr 0.012, Ke 0.015,
               Kc 1.0, Ks 0.5, Kd 1.0, Kh 5, Kdmax 10, minTilt 0.05,
               1000 iterations ; dt <= 0.5*sqrt(l^3/(A*g))
DROPLET        radius 3, inertia 0.05, capacityFactor 4, minCapacity 0.01,
               erode 0.3, deposit 0.3, evaporate 0.01, gravity 4,
               lifetime 30, droplets = 1.0 x N^2
THERMAL        talus 38 deg, c 0.5, red-black, alternate axial/diagonal,
               5 pyramid levels x 40 passes

FLOW           A_crit = 0.3% of N^2 cells ; river width w0*sqrt(A/A_crit)
AO             16 directions x 24 geometric steps, maxDist 0.1*N
TWI            tanB floor 0.001, display remap smoothstep(6,14)
QUANTIZE       uint16, TPDF blue-noise dither at +/-0.5 LSB, round() not floor()
```

### 11.2 Reference list (URL + what to read)

**Erosion**
* Mei, Decaudin, Hu (2007), *Fast Hydraulic Erosion Simulation and Visualization on GPU*, Pacific Graphics.
  <http://evasion.inrialpes.fr/Publications/2007/MDH07/FastErosion_PG07.pdf> — §3 eqs (1)–(15); §4 the
  7-pass GPU decomposition; Table 1 perf/Δt vs grid size.
* Jákó (2011), *Fast Hydraulic and Thermal Erosion on the GPU*, CESCG.
  <https://old.cescg.org/CESCG-2011/papers/TUBudapest-Jako-Balazs.pdf> — eqs (2)–(18); **Table 2 is the
  parameter table you want**; note the `min`/`max` typo in eq. (4) and the `sin(α|v|)` typo in eq. (9).
* O'Brien & Hodgins (1995), *Dynamic Simulation of Splashing Fluids*, Computer Animation '95 — the
  original virtual pipe model.
* Beyer (2015), *Implementation of a method for hydraulic erosion*, BSc thesis, TU München.
  <https://www.firespark.de/resources/downloads/implementation%20of%20a%20methode%20for%20hydraulic%20erosion.pdf>
* Lague, `SebLague/Hydraulic-Erosion` — <https://github.com/SebLague/Hydraulic-Erosion>;
  `Assets/Scripts/Erosion.cs` (CPU reference, params at L5–22, core loop L47–128, brush L155–201);
  `Assets/Scripts/ComputeShaders/Erosion.compute` (GPU, `[numthreads(1024,1,1)]` at L50).
* Olsen (2004), *Realtime Procedural Terrain Generation*, IMADA/SDU.
  <http://web.mit.edu/cesium/Public/terrain.pdf> — thermal reference + fast variant; hydraulic reference
  (Beneš & Forsbach) + optimized variant; constants `Kr=0.01, Ks=0.01, Ke=0.5, Kc=0.01`.
* Musgrave, Kolb, Mace (1989), *The Synthesis and Rendering of Eroded Fractal Terrains*, SIGGRAPH '89
  pp. 41–50; and Musgrave's later essay
  <https://www.classes.cs.uchicago.edu/archive/2015/fall/23700-1/final-project/MusgraveTerrain00.pdf>
  §2.6 "Slumping: Forming Talus Slopes" (the `talus_moved = delta - talus_slope` filter).

**Landscape evolution**
* Cordonnier, Braun, Cani, Benes, Galin, Peytavie, Guérin (2016), *Large Scale Terrain Generation from
  Tectonic Uplift and Fluvial Erosion*, CGF 35(2):165–175.
  <https://www.cs.purdue.edu/cgvlab/www/resources/papers/Cordonnier-Computer_Graphics_Forum-2016-Large_Scale_Terrain_Generation_from_Tectonic_Uplift_and_Fluvial_.pdf>
  — eq. (1) SPL, eq. (2) implicit solver, §3.2 algorithm, §6 parameter values.
* Braun & Willett (2013), *A very efficient O(n), implicit and parallel method to solve the stream power
  equation governing fluvial incision and landscape evolution*, Geomorphology 180–181:170–179.
* Whipple & Tucker (1999), *Dynamics of the stream-power river incision model*, JGR 104(B8).
* Schott, Paris, Fournier, Guérin, Galin (2023), *Large-scale Terrain Authoring through Interactive
  Erosion Simulation*, ACM TOG 42(5). <https://dl.acm.org/doi/10.1145/3592787>
* Guérin, Digne, Galin, Peytavie (2016), *Sparse representation of terrains for procedural modeling*,
  CGF 35(2):177–187. <https://perso.liris.cnrs.fr/eguerin/download/eg2016.pdf> ·
  <https://github.com/eric-guerin/terrain-amplification>
* Guérin et al. (2017), *Interactive Example-Based Terrain Authoring with Conditional GANs*, TOG 36(6).

**Hydrology**
* Tarboton (1997), *A new method for the determination of flow directions and upslope areas in grid
  digital elevation models*, WRR 33(2):309–319. <https://hydrology.usu.edu/dtarb/96wr03137.pdf> —
  eqs (1)–(6) and **Table 1** (the facet table, reproduced in §5.2).
* Barnes, Lehman, Mulla (2014), *Priority-Flood: An Optimal Depression-Filling and Watershed-Labeling
  Algorithm for DEMs*, Computers & Geosciences 62:117–127. <https://arxiv.org/abs/1511.04463> —
  Algorithms 1–5 (quoted in §5.4/§5.5), §4 on priority-queue ordering, complexity table §2.
* Planchon & Darboux (2002), *A fast, simple and versatile algorithm to fill the depressions of DEMs*,
  Catena 46(2–3):159–176.
  <https://horizon.documentation.ird.fr/exl-doc/pleins_textes/divers20-05/010031925.pdf> — Tables 3 & 4.
* O'Callaghan & Mark (1984), *The extraction of drainage networks from digital elevation data*, CVGIP 28.
* Beven & Kirkby (1979), *A physically based, variable contributing area model of basin hydrology*
  (TOPMODEL / TWI), Hydrological Sciences Bulletin 24(1).

**Noise & derived maps**
* Inigo Quilez: <https://iquilezles.org/articles/fbm/> (fBm & Hurst),
  <https://iquilezles.org/articles/morenoise/> (analytic derivatives; the `1/(1+dot(d,d))` terrain),
  <https://iquilezles.org/articles/warp/> (domain warping),
  <https://iquilezles.org/articles/smoothvoronoi/>, <https://iquilezles.org/articles/voronoise/>.
* Giliam de Carpentier, *Scape: Procedural Extensions* — <http://www.decarpentier.nl/scape-procedural-extensions>
  (**swissTurbulence** and **jordanTurbulence**, with full signatures and defaults).
* KdotJPG, **OpenSimplex2** — <https://github.com/KdotJPG/OpenSimplex2> (CC0/Unlicense; 2S recommended
  for ridged noise; `noise3_ImproveXY` for domain-rotated 3D).
* Worley (1996), *A Cellular Texture Basis Function*, SIGGRAPH '96.
* Ebert, Musgrave, Peachey, Perlin, Worley, *Texturing & Modeling: A Procedural Approach*, 3rd ed. —
  ch. 16 for `RidgedMultifractal`, `HybridMultifractal`, `fBm`, `MultiFractal`.
* Horn (1981), *Hill shading and the reflectance map*, Proc. IEEE 69(1) — the 3×3 slope/aspect operator.
* Zevenbergen & Thorne (1987), *Quantitative analysis of land surface topography*, ESPL 12 — curvature.
* Bavoil, Sainz, Dimitrov (2008), *Image-Space Horizon-Based Ambient Occlusion*, SIGGRAPH talks.
* Rong & Tan (2006), *Jump Flooding in GPU with Applications to Voronoi Diagram and Distance Transform*,
  I3D — the JFA of §8.6.
* Felzenszwalb & Huttenlocher (2004/2012), *Distance Transforms of Sampled Functions* — exact EDT.

**Platform**
* WebGPU spec — limits <https://www.w3.org/TR/webgpu/#limits>;
  plain-colour format capability table <https://www.w3.org/TR/webgpu/#plain-color-formats>;
  features (`float32-filterable`, `float32-blendable`, `bgra8unorm-storage`, `subgroups`,
  `texture-formats-tier1/tier2`, `timestamp-query`) <https://www.w3.org/TR/webgpu/#gpufeaturename>.
* WGSL spec — language extensions (`readonly_and_readwrite_storage_textures`, `textureBarrier`)
  <https://www.w3.org/TR/WGSL/#language-extensions>; atomic types
  <https://www.w3.org/TR/WGSL/#atomic-types>; alignment/size <https://www.w3.org/TR/WGSL/#alignment-and-size>.
* Recoil/Spring SMF format — <https://github.com/beyond-all-reason/RecoilEngine>,
  `rts/Map/SMF/SMFFormat.h` (header at L49–70, constants at L28/31/34, tile note at L173).
