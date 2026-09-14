/**
 * Where the painted surface sits on the terrain.
 *
 * One line of arithmetic, in its own file, because it is half of an invariant
 * whose other half lives in three.js and it was wrong for a long time without
 * anybody seeing it.
 *
 * The surface worker hands back the satmap as a row-major buffer whose first
 * row is the map's near edge — world z = 0, the same row the heightfield's
 * first row describes. That buffer becomes a `THREE.DataTexture`, and a
 * `DataTexture` sets `flipY = false`, so its first row is uploaded to v = 0.
 * The terrain's vertex at grid row `y` therefore wants `v = y / (height - 1)`.
 *
 * The obvious-looking `1 - y / (height - 1)` is the convention for an image
 * *file*, where row zero is the top of the picture and `flipY` defaults to true
 * to compensate. Used here it mirrored the entire satmap along Z: every colour
 * the palette computed for the north edge was drawn on the south one. It
 * survived because the shipped templates are symmetric — on a map that declares
 * a half turn a Z mirror comes out as a left-right mirror, which still looks
 * like a plausible map, just one whose texture has nothing to do with its
 * terrain.
 */
export function terrainUv(
  x: number,
  y: number,
  width: number,
  height: number,
): readonly [number, number] {
  return [x / Math.max(1, width - 1), y / Math.max(1, height - 1)];
}
