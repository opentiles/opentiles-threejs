import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { Selector, type SelectorHost, type SelectorView } from '../src/selector';
import { effectiveErrorM, screenSpaceError } from '../src/sse';
import { childrenOf, TileGrid, tileKey } from '../src/tile';
import type { TileCoord } from '../src/types';

describe('effectiveErrorM', () => {
  it('floors a zero geometric error at the texel size', () => {
    expect(effectiveErrorM(0, 256, 1, 1)).toBe(1); // 256 m edge → 1 m texel
    expect(effectiveErrorM(10, 256, 1, 1)).toBe(10);
  });
  it('texelErrorScale 0 makes error 0 a hard leaf', () => {
    expect(effectiveErrorM(0, 256, 0, 1)).toBe(0);
  });
  it('uses the fallback when metadata is unknown', () => {
    expect(effectiveErrorM(null, 256, 0, 7)).toBe(7);
  });
  it('projects to screen pixels', () => {
    expect(screenSpaceError(10, 1000, 800)).toBe(8);
  });
});

/** A host over in-memory state, camera straight down over the reference tile. */
function makeWorld() {
  const grid = new TileGrid(36.07, -112.1, 9);
  const ready = new Set<string>();
  const required = new Map<string, number>();
  const visited = new Set<string>();
  const host: SelectorHost = {
    minZoom: 9,
    maxZoom: 10,
    maxScreenError: 2,
    hysteresis: 1.4,
    grid,
    effectiveError: (t: TileCoord) => grid.edge(t.z) / 256,
    heightRange: () => [0, 0] as const,
    state: (t: TileCoord) => (ready.has(tileKey(t)) ? 'ready' : 'pending'),
    require: (t: TileCoord, sse: number) => required.set(tileKey(t), sse),
    visit: (t: TileCoord) => visited.add(tileKey(t)),
  };
  const view = (heightM: number): SelectorView => {
    const camera = new PerspectiveCamera(50, 1, 1, 10_000_000);
    const e = grid.edge(9);
    camera.position.set(e / 2, heightM, e / 2); // over the reference tile centre
    camera.lookAt(e / 2, 0, e / 2);
    camera.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    return {
      position: camera.position,
      frustum,
      sseFactor: 800 / (2 * Math.tan((camera.fov * Math.PI) / 360)),
      near: camera.near,
    };
  };
  return { grid, host, ready, required, visited, view };
}

// sse at the reference tile ≈ (edge/256) · 857 / height:
//   height 200 000 → ~1.05 (below budget 2, and below keep-threshold 2/1.4)
//   height 124 000 → ~1.7  (between keep-threshold and budget)
//   height   2 000 → ~105  (far above budget)
describe('Selector', () => {
  let world: ReturnType<typeof makeWorld>;
  let selector: Selector;
  beforeEach(() => {
    world = makeWorld();
    selector = new Selector();
  });

  it('draws a ready root as a leaf when the error budget holds', () => {
    const refKey = tileKey(world.grid.ref);
    world.ready.add(refKey);
    const { draw } = selector.select(world.host, world.view(200_000));
    expect(draw).toContain(refKey);
    expect(world.required.has(refKey)).toBe(true);
    for (const k of draw) expect(k.startsWith('9/')).toBe(true); // nothing split
  });

  it('splits when close, keeps the parent visible until all children are ready', () => {
    const refKey = tileKey(world.grid.ref);
    const kids = childrenOf(world.grid.ref).map(tileKey);
    world.ready.add(refKey);

    let { draw } = selector.select(world.host, world.view(2_000));
    // children requested (all four meet under the camera), parent stands in
    for (const k of kids) expect(world.required.has(k)).toBe(true);
    expect(draw).toEqual([refKey]);

    for (const k of kids) world.ready.add(k);
    ({ draw } = selector.select(world.host, world.view(2_000)));
    expect(draw.sort()).toEqual([...kids].sort());
    expect(draw).not.toContain(refKey);
  });

  it('applies hysteresis: a borderline sse keeps the previous split state', () => {
    const refKey = tileKey(world.grid.ref);
    const kids = childrenOf(world.grid.ref).map(tileKey);
    world.ready.add(refKey);
    for (const k of kids) world.ready.add(k);

    // fresh selector at the borderline height: no split
    let { draw } = selector.select(world.host, world.view(124_000));
    expect(draw).toEqual([refKey]);

    // split low, then rise to the same borderline: split is kept
    selector.select(world.host, world.view(2_000));
    ({ draw } = selector.select(world.host, world.view(124_000)));
    expect(draw.sort()).toEqual([...kids].sort());

    // rising further drops below the keep-threshold: merge back
    ({ draw } = selector.select(world.host, world.view(200_000)));
    expect(draw).toEqual([refKey]);
  });

  it('prefetches metadata for every visited tile', () => {
    world.ready.add(tileKey(world.grid.ref));
    selector.select(world.host, world.view(2_000));
    expect(world.visited.has(tileKey(world.grid.ref))).toBe(true);
    for (const k of childrenOf(world.grid.ref).map(tileKey)) {
      expect(world.visited.has(k)).toBe(true);
    }
  });
});
