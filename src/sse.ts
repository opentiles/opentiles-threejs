import { TILE_TEXELS } from './tile';

/**
 * The tile's effective refinement error in metres (spec "LOD algorithm"):
 * the geometric error floored by the on-the-ground size of one imagery
 * texel, `texelErrorScale · edge / 256` — so a height-leaf tile
 * (`geometric_error_m: 0`) still refines for texture sharpness. Pass
 * `geometricErrorM: null` when the tile's metadata is not (yet) known; the
 * fallback error is then used in its place.
 */
export function effectiveErrorM(
  geometricErrorM: number | null,
  edgeM: number,
  texelErrorScale: number,
  fallbackErrorM: number,
): number {
  const floor = (texelErrorScale * edgeM) / TILE_TEXELS;
  return Math.max(geometricErrorM ?? fallbackErrorM, floor);
}

/**
 * Project an error in metres to screen pixels:
 * `sse = errorM · sseFactor / distance`, where
 * `sseFactor = viewportHeightPx / (2 · tan(fovY / 2))`.
 */
export function screenSpaceError(errorM: number, distanceM: number, sseFactor: number): number {
  return (errorM * sseFactor) / distanceM;
}
