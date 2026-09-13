# Terrain Generation & Erosion Algorithms (Implementation-Grade)

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
