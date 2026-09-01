import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';

/** A slippy-map tile address: `z/x/y`, `y` increasing southward. */
export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** The server's per-tile metadata document (`{z}/{x}/{y}.json`). */
export interface TileMetadata {
  zoom: number;
  x: number;
  y: number;
  tile_size_m: number;
  min_height_m: number;
  max_height_m: number;
  geometric_error_m: number;
}

/** Loading progress snapshot for `onProgress`. */
export interface Progress {
  /** Tiles resident in the cache (ready to draw). */
  loaded: number;
  /** Tile requests queued or in flight. */
  pending: number;
}

/** Event callbacks; all optional. */
export interface OpenTilesEvents {
  /** A tile's GLB finished loading and entered the cache. */
  onLoad?: (tile: TileCoord) => void;
  /** A tile failed to load (after retries); 404s are not errors. */
  onError?: (tile: TileCoord, error: unknown) => void;
  /** Loading progress changed. */
  onProgress?: (progress: Progress) => void;
  /**
   * The world origin was re-based to keep float precision: every library
   * object was shifted by `-delta`; the host MUST shift its camera and its
   * own world-anchored objects by `-delta` too. Re-basing only happens when
   * this callback is provided.
   */
  onOriginShift?: (delta: { x: number; z: number }) => void;
}

/** Constructor options for {@link OpenTiles}. Only `serverUrl`, `scene`, `camera` and `renderer` are required. */
export interface OpenTilesOptions extends OpenTilesEvents {
  /** Base URL of the opentiles server, e.g. `http://127.0.0.1:8080`. */
  serverUrl: string;
  /** Host scene; the library adds one `Group` and never touches anything else. */
  scene: Scene;
  /** Host camera; drives LOD selection (fov, position, frustum). Never moved by the library. */
  camera: PerspectiveCamera;
  /** Host renderer; used for the viewport size the SSE depends on. */
  renderer: WebGLRenderer;
  /** Quadtree root zoom (default 9). */
  minZoom?: number;
  /** Deepest zoom to refine into (default 17). */
  maxZoom?: number;
  /** Reference latitude: defines the world origin tile (default 36.07). */
  lat?: number;
  /** Reference longitude (default −112.10). */
  lon?: number;
  /** Screen-space error budget in pixels (default 2). */
  maxScreenError?: number;
  /** Merge-back factor preventing LOD flicker (default 1.4). */
  hysteresis?: number;
  /** Parallel GLB fetches (default 10). */
  maxConcurrentLoads?: number;
  /** Retained-tile budget for the LRU cache, in tiles (default 600). */
  cacheBudget?: number;
  /**
   * Multiplier on the texture-error floor `tile_size_m / 256` (default 1).
   * `0` disables the floor: a zero geometric error is then a hard leaf.
   */
  texelErrorScale?: number;
  /** Error model for tiles whose `.json` is missing (default `size / 256`). */
  fallbackGeometricError?: (tileSizeM: number) => number;
  /** Re-base the origin when the camera is this far from it (default 50 000 m; needs `onOriginShift`). */
  rebaseThresholdM?: number;
  /** Minimum interval between LOD selection passes in ms (default 250). */
  updateIntervalMs?: number;
}

/** {@link OpenTilesOptions} with every default applied. */
export type ResolvedOptions = Required<
  Omit<OpenTilesOptions, keyof OpenTilesEvents | 'scene' | 'camera' | 'renderer'>
> &
  Pick<OpenTilesOptions, keyof OpenTilesEvents | 'scene' | 'camera' | 'renderer'>;

/** Defaults for every optional {@link OpenTilesOptions} field. */
export const DEFAULT_OPTIONS = {
  minZoom: 9,
  maxZoom: 17,
  lat: 36.07,
  lon: -112.1,
  maxScreenError: 2,
  hysteresis: 1.4,
  maxConcurrentLoads: 10,
  cacheBudget: 600,
  texelErrorScale: 1,
  fallbackGeometricError: (tileSizeM: number) => tileSizeM / 256,
  rebaseThresholdM: 50_000,
  updateIntervalMs: 250,
} as const;
