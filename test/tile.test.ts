import { describe, expect, it } from 'vitest';
import { childrenOf, tileAt, TileGrid, tileKey, tileSizeM } from '../src/tile';

describe('tile math', () => {
  it('matches the server anchor math', () => {
    // same fixtures as the server's tile.rs tests
    const dolomites = tileAt(46.206889, 9.497194, 9);
    expect([dolomites.x, dolomites.y]).toEqual([269, 181]);
    const canyon = tileAt(36.1, -112.1, 12);
    expect([canyon.x, canyon.y]).toEqual([772, 1607]);
    expect(tileSizeM(12, 1607)).toBeCloseTo(7908.657, 2);
  });

  it('clamps and wraps lookups', () => {
    const top = tileAt(89, 180, 3);
    expect([top.x, top.y]).toEqual([0, 0]);
    const bottom = tileAt(-89, 179.999, 3);
    expect([bottom.x, bottom.y]).toEqual([7, 7]);
  });

  it('children cover the parent quadrant-wise', () => {
    const kids = childrenOf({ z: 10, x: 500, y: 400 });
    expect(kids.map(tileKey)).toEqual([
      '11/1000/800',
      '11/1001/800',
      '11/1000/801',
      '11/1001/801',
    ]);
  });
});

describe('TileGrid', () => {
  const grid = new TileGrid(36.07, -112.1, 9);

  it('halves the edge per zoom and places children in parent quadrants', () => {
    expect(grid.edge(10)).toBeCloseTo(grid.edge(9) / 2, 9);
    const parent = grid.origin(grid.ref);
    expect(parent.x).toBe(0);
    expect(parent.z).toBe(0);
    const [nw, ne, sw, se] = childrenOf(grid.ref);
    expect(grid.origin(nw)).toEqual({ x: 0, z: 0 });
    expect(grid.origin(ne).x).toBeCloseTo(grid.edge(10), 6);
    expect(grid.origin(sw).z).toBeCloseTo(grid.edge(10), 6);
    expect(grid.origin(se).x).toBeCloseTo(grid.edge(10), 6);
    expect(grid.origin(se).z).toBeCloseTo(grid.edge(10), 6);
  });

  it('round-trips lat/lon through world coordinates', () => {
    const w = grid.latLonToWorld(36.1, -112.1);
    const back = grid.worldToLatLon(w.x, w.z);
    expect(back.lat).toBeCloseTo(36.1, 6);
    expect(back.lon).toBeCloseTo(-112.1, 6);
  });

  it('anchor shifts move scene positions but not geography', () => {
    const g = new TileGrid(36.07, -112.1, 9);
    const before = g.latLonToWorld(36.1, -112.1);
    g.shiftAnchor(1000, -500);
    const after = g.latLonToWorld(36.1, -112.1);
    expect(after.x).toBeCloseTo(before.x - 1000, 6);
    expect(after.z).toBeCloseTo(before.z + 500, 6);
    const back = g.worldToLatLon(after.x, after.z);
    expect(back.lat).toBeCloseTo(36.1, 6);
    expect(back.lon).toBeCloseTo(-112.1, 6);
  });
});
