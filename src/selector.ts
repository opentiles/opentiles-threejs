import { Box3, Frustum, Vector3 } from 'three';
import { childrenOf, tileKey, TileGrid } from './tile';
import type { TileCoord } from './types';

/** How far (in root tiles) around the camera roots are enumerated. */
const ROOT_WINDOW = 16;

/** What the selector needs from its host (OpenTiles, or a test stub). */
export interface SelectorHost {
  minZoom: number;
  maxZoom: number;
  maxScreenError: number;
  hysteresis: number;
  grid: TileGrid;
  /** Effective error in metres (geometric error with the texel floor applied). */
  effectiveError(tile: TileCoord): number;
  /** `[min, max]` height for the tile's bounding box. */
  heightRange(tile: TileCoord): readonly [number, number];
  /** Whether the tile's mesh is resident: ready to draw, still pending, or known absent. */
  state(tile: TileCoord): 'ready' | 'pending' | 'missing';
  /** The tile should be resident: queue its load (if needed) and pin it. `sse` is its priority. */
  require(tile: TileCoord, sse: number): void;
  /** Called for every non-culled tile the walk touches (metadata prefetch). */
  visit(tile: TileCoord, sse: number): void;
}

/** Camera-derived inputs of one pass. */
export interface SelectorView {
  position: Vector3;
  frustum: Frustum;
  /** `viewportHeightPx / (2 · tan(fovY / 2))`. */
  sseFactor: number;
  near: number;
}

/** Result of one pass: the tiles to show this frame. */
export interface Selection {
  /** Keys of tiles to draw (hole-free: parents stand in for incomplete children). */
  draw: string[];
}

interface Resolved {
  covered: boolean;
  draw: string[];
}

/**
 * The quadtree walk (spec `threejs.md` "LOD algorithm"): cull against the
 * frustum, split while the screen-space error exceeds the budget (with
 * hysteresis via the previous pass's split set), and resolve visibility
 * hole-free — a parent is drawn until all 4 children are resident.
 *
 * Allocation-conscious: `Box3`/`Vector3` scratch objects are reused; the
 * only per-pass allocations are the result arrays and the new split set.
 */
export class Selector {
  private splitSet = new Set<string>();
  private readonly box = new Box3();
  private readonly boxMin = new Vector3();
  private readonly boxMax = new Vector3();

  select(host: SelectorHost, view: SelectorView): Selection {
    const newSplit = new Set<string>();
    const draw: string[] = [];

    const n = 2 ** host.minZoom;
    const rootEdge = host.grid.edge(host.minZoom);
    const anchor = host.grid.anchor;
    const camTileX = host.grid.ref.x + Math.floor((view.position.x + anchor.x) / rootEdge);
    const camTileY = host.grid.ref.y + Math.floor((view.position.z + anchor.z) / rootEdge);
    const x0 = Math.max(camTileX - ROOT_WINDOW, 0);
    const x1 = Math.min(camTileX + ROOT_WINDOW, n - 1);
    const y0 = Math.max(camTileY - ROOT_WINDOW, 0);
    const y1 = Math.min(camTileY + ROOT_WINDOW, n - 1);

    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const r = this.resolve({ z: host.minZoom, x, y }, host, view, newSplit);
        for (const k of r.draw) draw.push(k);
      }

    this.splitSet = newSplit;
    return { draw };
  }

  /** Drop all split state (config change, dispose). */
  reset(): void {
    this.splitSet.clear();
  }

  private resolve(
    tile: TileCoord,
    host: SelectorHost,
    view: SelectorView,
    newSplit: Set<string>,
  ): Resolved {
    const { x, z } = host.grid.origin(tile);
    const edge = host.grid.edge(tile.z);
    const [minH, maxH] = host.heightRange(tile);
    this.boxMin.set(x, minH, z);
    this.boxMax.set(x + edge, maxH, z + edge);
    this.box.set(this.boxMin, this.boxMax);
    if (!view.frustum.intersectsBox(this.box)) return { covered: true, draw: [] };

    const d = Math.max(this.box.distanceToPoint(view.position), view.near);
    const sse = (host.effectiveError(tile) * view.sseFactor) / d;
    const key = tileKey(tile);
    host.visit(tile, sse);

    const split =
      tile.z < host.maxZoom &&
      (sse > host.maxScreenError ||
        (this.splitSet.has(key) && sse > host.maxScreenError / host.hysteresis));

    if (split) {
      newSplit.add(key);
      let covered = true;
      const draw: string[] = [];
      for (const child of childrenOf(tile)) {
        const r = this.resolve(child, host, view, newSplit);
        covered &&= r.covered;
        if (r.covered) for (const k of r.draw) draw.push(k);
      }
      if (covered) return { covered: true, draw };
      // children incomplete: the parent stands in until all four are resident
      if (host.state(tile) === 'ready') {
        host.require(tile, sse);
        return { covered: true, draw: [key] };
      }
      return { covered: false, draw: [] };
    }

    host.require(tile, sse);
    return host.state(tile) === 'ready'
      ? { covered: true, draw: [key] }
      : { covered: false, draw: [] };
  }
}
