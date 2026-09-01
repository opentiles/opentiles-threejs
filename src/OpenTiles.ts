import { Frustum, Group, Matrix4, Mesh, Vector3 } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LruCache } from './lru';
import { fetchBytes, FetchQueue } from './queue';
import { Selector, type SelectorHost } from './selector';
import { effectiveErrorM } from './sse';
import { TileGrid, tileKey, tileSizeM } from './tile';
import {
  DEFAULT_OPTIONS,
  type OpenTilesOptions,
  type ResolvedOptions,
  type TileCoord,
  type TileMetadata,
} from './types';

/** Concurrency for the (tiny) metadata fetches. */
const META_CONCURRENCY = 16;
/** How long a failed tile stays failed before it may be retried (ms). */
const FAILURE_COOLDOWN_MS = 5_000;
/** Camera movement below this many metres does not trigger a pass. */
const MOVE_EPSILON_M = 0.5;

interface TileEntry {
  coord: TileCoord;
  state: 'loading' | 'ready' | 'missing' | 'failed';
  group: Group | null;
  failedAt: number;
}

/**
 * A quadtree-LOD terrain layer streaming tiles from an opentiles server.
 * See `threejs.md` (spec) — this class owns one `Group` in the host scene
 * and drives selection/loading from `update()`.
 */
export class OpenTiles {
  /** The library's root object (added to the host scene; exposed for debug overlays). */
  readonly group = new Group();
  /** The world grid (geo ↔ scene conversions share it). */
  readonly grid: TileGrid;

  private readonly opts: ResolvedOptions;
  private readonly tiles: LruCache<TileEntry>;
  private readonly meta = new Map<string, TileMetadata | 'pending' | 'none'>();
  private readonly metaByKey = new Map<string, TileCoord>();
  private readonly selector = new Selector();
  private readonly glbQueue: FetchQueue;
  private readonly metaQueue: FetchQueue;
  private readonly gltfLoader = new GLTFLoader();
  private readonly sources = new Set<string>();

  private required = new Set<string>();
  private shownKeys = new Set<string>();
  private globalHeights: [number, number] = [0, 9000];
  private dirty = true;
  private lastPass = 0;
  private lastCameraPos = new Vector3(Infinity, Infinity, Infinity);
  private lastCameraQuat = { x: 0, y: 0, z: 0, w: 0 };
  private lastViewport = { w: 0, h: 0 };
  private disposed = false;

  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();

  constructor(options: OpenTilesOptions) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    if (this.opts.maxZoom < this.opts.minZoom)
      throw new Error(`maxZoom ${this.opts.maxZoom} below minZoom ${this.opts.minZoom}`);
    this.grid = new TileGrid(this.opts.lat, this.opts.lon, this.opts.minZoom);
    this.tiles = new LruCache<TileEntry>(this.opts.cacheBudget);
    this.glbQueue = new FetchQueue({
      concurrency: this.opts.maxConcurrentLoads,
      run: (key, signal) => this.loadGlb(key, signal),
    });
    this.metaQueue = new FetchQueue({
      concurrency: META_CONCURRENCY,
      run: (key, signal) => this.loadMeta(key, signal),
    });
    this.group.name = 'opentiles';
    this.opts.scene.add(this.group);
  }

  /**
   * Drive the layer; call every frame. Cheap when idle: a full selection
   * pass only runs when the camera moved, the viewport changed, a load
   * landed, or `updateIntervalMs` passed since the last one while dirty.
   */
  update(): void {
    if (this.disposed) return;
    const camera = this.opts.camera;
    const el = this.opts.renderer.domElement;
    const moved =
      camera.position.distanceToSquared(this.lastCameraPos) > MOVE_EPSILON_M ** 2 ||
      camera.quaternion.x !== this.lastCameraQuat.x ||
      camera.quaternion.y !== this.lastCameraQuat.y ||
      camera.quaternion.z !== this.lastCameraQuat.z ||
      camera.quaternion.w !== this.lastCameraQuat.w;
    const resized = el.clientWidth !== this.lastViewport.w || el.clientHeight !== this.lastViewport.h;
    if (!moved && !resized && !this.dirty) return;
    const now = performance.now();
    if (now - this.lastPass < this.opts.updateIntervalMs) return;
    this.lastPass = now;
    this.dirty = false;
    this.lastCameraPos.copy(camera.position);
    const q = camera.quaternion;
    this.lastCameraQuat = { x: q.x, y: q.y, z: q.z, w: q.w };
    this.lastViewport = { w: el.clientWidth, h: el.clientHeight };
    this.pass();
  }

  /** Scene-space position of a geographic coordinate (`y` is left to the caller). */
  latLonToWorld(lat: number, lon: number): { x: number; z: number } {
    return this.grid.latLonToWorld(lat, lon);
  }

  /** Geographic coordinate under a scene-space position. */
  worldToLatLon(x: number, z: number): { lat: number; lon: number } {
    return this.grid.worldToLatLon(x, z);
  }

  /** Attribution strings of every source seen so far (hosts must display them). */
  attribution(): string[] {
    return [...this.sources].sort();
  }

  /** Abort everything, release every GPU resource, leave the scene untouched otherwise. */
  dispose(): void {
    this.disposed = true;
    this.glbQueue.clear();
    this.metaQueue.clear();
    this.tiles.clear((_k, e) => this.disposeEntry(e));
    this.meta.clear();
    this.metaByKey.clear();
    this.selector.reset();
    this.opts.scene.remove(this.group);
  }

  // -- selection pass -------------------------------------------------------

  private pass(): void {
    const { camera, renderer } = this.opts;
    this.maybeRebase();
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const sseFactor =
      renderer.domElement.clientHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));

    const required = new Set<string>();
    const host: SelectorHost = {
      minZoom: this.opts.minZoom,
      maxZoom: this.opts.maxZoom,
      maxScreenError: this.opts.maxScreenError,
      hysteresis: this.opts.hysteresis,
      grid: this.grid,
      effectiveError: (t) => this.effectiveError(t),
      heightRange: (t) => this.heightRange(t),
      state: (t) => this.tileState(t),
      require: (t, sse) => {
        const key = tileKey(t);
        required.add(key);
        this.requestGlb(t, key, sse);
      },
      visit: (t, sse) => this.requestMeta(t, sse),
    };

    const { draw } = this.selector.select(host, {
      position: camera.position,
      frustum: this.frustum,
      sseFactor,
      near: camera.near,
    });
    this.required = required;

    // visibility diff
    const newShown = new Set(draw);
    for (const key of this.shownKeys)
      if (!newShown.has(key)) {
        const g = this.tiles.get(key)?.group;
        if (g) g.visible = false;
      }
    for (const key of newShown) {
      const entry = this.tiles.get(key);
      if (entry?.group) {
        entry.group.visible = true;
        this.tiles.touch(key);
      }
    }
    this.shownKeys = newShown;

    // drop what is no longer wanted, evict beyond the budget
    this.glbQueue.retain((key) => this.required.has(key), true);
    this.metaQueue.retain(() => true, false); // metadata is tiny: let it finish and cache
    this.tiles.prune(
      (key, e) => this.required.has(key) || this.shownKeys.has(key) || e.state === 'loading',
      (_key, e) => this.disposeEntry(e),
    );

    this.opts.onProgress?.({ loaded: this.tiles.size, pending: this.glbQueue.pending });
  }

  private maybeRebase(): void {
    if (!this.opts.onOriginShift) return;
    const p = this.opts.camera.position;
    if (Math.hypot(p.x, p.z) < this.opts.rebaseThresholdM) return;
    const dx = Math.round(p.x);
    const dz = Math.round(p.z);
    this.grid.shiftAnchor(dx, dz);
    for (const entry of this.tiles.values())
      if (entry.group) {
        entry.group.position.x -= dx;
        entry.group.position.z -= dz;
        entry.group.updateMatrix();
      }
    this.opts.onOriginShift({ x: dx, z: dz });
  }

  // -- LOD inputs -----------------------------------------------------------

  private effectiveError(t: TileCoord): number {
    const edge = this.grid.edge(t.z);
    const m = this.meta.get(tileKey(t));
    const geometric = m === undefined || m === 'pending' || m === 'none' ? null : m.geometric_error_m;
    return effectiveErrorM(
      geometric,
      edge,
      this.opts.texelErrorScale,
      this.opts.fallbackGeometricError(edge),
    );
  }

  private heightRange(t: TileCoord): readonly [number, number] {
    const m = this.meta.get(tileKey(t));
    if (m === undefined || m === 'pending' || m === 'none') return this.globalHeights;
    return [m.min_height_m, m.max_height_m];
  }

  private tileState(t: TileCoord): 'ready' | 'pending' | 'missing' {
    const entry = this.tiles.get(tileKey(t));
    if (!entry) return 'pending';
    if (entry.state === 'ready') return 'ready';
    if (entry.state === 'missing') return 'missing';
    if (entry.state === 'failed') {
      return performance.now() - entry.failedAt > FAILURE_COOLDOWN_MS ? 'pending' : 'missing';
    }
    return 'pending';
  }

  // -- loading --------------------------------------------------------------

  private requestGlb(t: TileCoord, key: string, sse: number): void {
    const entry = this.tiles.get(key);
    if (entry) {
      if (entry.state === 'failed' && performance.now() - entry.failedAt > FAILURE_COOLDOWN_MS)
        this.tiles.delete(key);
      else {
        if (entry.state === 'loading') this.glbQueue.request(key, sse);
        return;
      }
    }
    this.tiles.set(key, { coord: t, state: 'loading', group: null, failedAt: 0 });
    this.glbQueue.request(key, sse);
  }

  private requestMeta(t: TileCoord, sse: number): void {
    const key = tileKey(t);
    if (this.meta.has(key)) return;
    this.meta.set(key, 'pending');
    this.metaByKey.set(key, t);
    this.metaQueue.request(key, sse);
  }

  private async loadGlb(key: string, signal: AbortSignal): Promise<void> {
    const entry = this.tiles.get(key);
    if (!entry) return;
    try {
      const bytes = await fetchBytes(`${this.opts.serverUrl}/${key}.glb`, signal);
      if (bytes === null) {
        entry.state = 'missing';
        this.dirty = true;
        return;
      }
      const gltf = await this.parseGlb(bytes);
      if (this.disposed || !this.tiles.has(key)) return;
      this.placeTile(entry, gltf);
      entry.state = 'ready';
      this.dirty = true;
      this.opts.onLoad?.(entry.coord);
    } catch (err) {
      if (signal.aborted || this.disposed) {
        this.tiles.delete(key);
        return;
      }
      entry.state = 'failed';
      entry.failedAt = performance.now();
      this.dirty = true;
      this.opts.onError?.(entry.coord, err);
    }
  }

  private parseGlb(bytes: ArrayBuffer): Promise<GLTF> {
    return new Promise((resolve, reject) => {
      this.gltfLoader.parse(bytes, '', resolve, reject);
    });
  }

  private placeTile(entry: TileEntry, gltf: GLTF): void {
    const t = entry.coord;
    const extras = (gltf.parser.json as { extras?: Record<string, unknown> }).extras ?? {};
    const size =
      typeof extras.tile_size_m === 'number' ? extras.tile_size_m : tileSizeM(t.z, t.y);
    const sources = extras.sources as { imagery?: string; elevation?: string } | undefined;
    if (sources?.imagery) this.sources.add(sources.imagery);
    if (sources?.elevation) this.sources.add(sources.elevation);

    const g = gltf.scene;
    const { x, z } = this.grid.origin(t);
    const edge = this.grid.edge(t.z);
    g.position.set(x, 0, z);
    g.scale.set(edge / size, 1, edge / size);
    g.matrixAutoUpdate = false;
    g.updateMatrix();
    g.visible = false;
    g.userData.tile = { ...t };
    g.userData.edge = edge;
    g.traverse((o) => {
      if (o instanceof Mesh) {
        o.matrixAutoUpdate = false;
        o.updateMatrix();
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      }
    });
    entry.group = g;
    this.group.add(g);
  }

  private async loadMeta(key: string, signal: AbortSignal): Promise<void> {
    const t = this.metaByKey.get(key);
    try {
      const bytes = await fetchBytes(`${this.opts.serverUrl}/${key}.json`, signal);
      if (this.disposed) return;
      if (bytes === null) {
        this.meta.set(key, 'none');
      } else {
        const m = JSON.parse(new TextDecoder().decode(bytes)) as TileMetadata;
        this.meta.set(key, m);
        this.globalHeights = [
          Math.min(this.globalHeights[0], m.min_height_m),
          Math.max(this.globalHeights[1], m.max_height_m),
        ];
      }
      this.dirty = true;
    } catch (err) {
      // forget it so a later pass retries; selection meanwhile uses the fallback
      this.meta.delete(key);
      this.metaByKey.delete(key);
      if (!signal.aborted && t) this.opts.onError?.(t, err);
    }
  }

  private disposeEntry(entry: TileEntry): void {
    const g = entry.group;
    if (!g) return;
    this.group.remove(g);
    g.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.geometry.dispose();
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) {
        for (const value of Object.values(m) as { isTexture?: boolean; dispose?: () => void }[]) {
          if (value && typeof value === 'object' && value.isTexture) value.dispose?.();
        }
        m.dispose();
      }
    });
    entry.group = null;
  }
}
