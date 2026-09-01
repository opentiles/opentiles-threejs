import type { TileCoord } from './types';

/** WGS84 equatorial circumference in metres (same constant as the server). */
export const EQUATOR_CIRCUMFERENCE_M = 40_075_016.686;

/** Highest latitude web-mercator covers. */
export const MAX_LATITUDE_DEG = 85.05112877980659;

/** Source texels per tile edge (heightmap and imagery are 256²). */
export const TILE_TEXELS = 256;

/** `z/x/y` — cache keys and server paths. */
export function tileKey(t: TileCoord): string {
  return `${t.z}/${t.x}/${t.y}`;
}

/** The 4 children of a tile at `z + 1`, NW, NE, SW, SE. */
export function childrenOf(t: TileCoord): [TileCoord, TileCoord, TileCoord, TileCoord] {
  const z = t.z + 1;
  const x = t.x * 2;
  const y = t.y * 2;
  return [
    { z, x, y },
    { z, x: x + 1, y },
    { z, x, y: y + 1 },
    { z, x: x + 1, y: y + 1 },
  ];
}

/** Fractional tile coordinates of `(lat, lon)` at `zoom` (unclamped in x/y). */
export function tileCoordsF(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const clampedLat = Math.min(Math.max(lat, -MAX_LATITUDE_DEG), MAX_LATITUDE_DEG);
  const wrappedLon = ((lon + 180) % 360 + 360) % 360 - 180;
  const latRad = (clampedLat * Math.PI) / 180;
  return {
    x: ((wrappedLon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/** The tile containing `(lat, lon)` at `zoom` (server §2.2 formulas). */
export function tileAt(lat: number, lon: number, zoom: number): TileCoord {
  const n = 2 ** zoom;
  const f = tileCoordsF(lat, lon, zoom);
  return {
    z: zoom,
    x: Math.min(Math.max(Math.floor(f.x), 0), n - 1),
    y: Math.min(Math.max(Math.floor(f.y), 0), n - 1),
  };
}

/** Latitude (degrees) of the centre of tile row `y` at `zoom`. */
export function tileCenterLat(zoom: number, y: number): number {
  const n = 2 ** zoom;
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
}

/** Tile edge length in metres at the tile's own centre latitude (server §3.3). */
export function tileSizeM(zoom: number, y: number): number {
  return (
    (EQUATOR_CIRCUMFERENCE_M * Math.cos((tileCenterLat(zoom, y) * Math.PI) / 180)) / 2 ** zoom
  );
}

/**
 * The uniform world grid (server specs §3.4, strategy 2): one edge length per
 * zoom derived from a reference tile at the root zoom, every position in
 * metres relative to the reference tile's NW corner minus a movable anchor
 * (the anchor implements origin re-basing — see `OpenTilesOptions.onOriginShift`).
 *
 * Scene frame: +X east, +Z south, Y metres above sea level.
 */
export class TileGrid {
  /** The reference tile (root zoom, contains the configured lat/lon). */
  readonly ref: TileCoord;
  /** Grid edge of the reference tile in metres. */
  readonly refEdge: number;
  private anchorX = 0;
  private anchorZ = 0;

  constructor(lat: number, lon: number, rootZoom: number) {
    this.ref = tileAt(lat, lon, rootZoom);
    this.refEdge = tileSizeM(this.ref.z, this.ref.y);
  }

  /** Grid edge length of a zoom-`z` tile in metres. */
  edge(z: number): number {
    return this.refEdge / 2 ** (z - this.ref.z);
  }

  /** Scene-space NW corner of a tile (anchor applied). */
  origin(t: TileCoord): { x: number; z: number } {
    const f = 2 ** (t.z - this.ref.z);
    const e = this.edge(t.z);
    return {
      x: (t.x - this.ref.x * f) * e - this.anchorX,
      z: (t.y - this.ref.y * f) * e - this.anchorZ,
    };
  }

  /** Scene-space position of a geographic coordinate (Y not included). */
  latLonToWorld(lat: number, lon: number): { x: number; z: number } {
    const f = tileCoordsF(lat, lon, this.ref.z);
    return {
      x: (f.x - this.ref.x) * this.refEdge - this.anchorX,
      z: (f.y - this.ref.y) * this.refEdge - this.anchorZ,
    };
  }

  /** Geographic coordinate of a scene-space position. */
  worldToLatLon(x: number, z: number): { lat: number; lon: number } {
    const n = 2 ** this.ref.z;
    const tx = this.ref.x + (x + this.anchorX) / this.refEdge;
    const ty = this.ref.y + (z + this.anchorZ) / this.refEdge;
    return {
      lon: (tx / n) * 360 - 180,
      lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI,
    };
  }

  /** Current anchor (accumulated origin shifts). */
  get anchor(): { x: number; z: number } {
    return { x: this.anchorX, z: this.anchorZ };
  }

  /** Move the anchor by `(dx, dz)`; every scene position shifts by `(-dx, -dz)`. */
  shiftAnchor(dx: number, dz: number): void {
    this.anchorX += dx;
    this.anchorZ += dz;
  }
}
