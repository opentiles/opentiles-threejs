# opentiles-threejs

Three.js client for the [opentiles server](../opentiles-server): a quadtree-LOD terrain layer
that keeps the whole camera frustum covered with tiles at the right detail, streaming GLBs on
demand. The design spec lives in the server repo (`threejs.md`).

## Usage

```ts
import { OpenTiles } from 'opentiles-threejs';

const tiles = new OpenTiles({
  serverUrl: 'http://127.0.0.1:8080',
  scene,
  camera,      // PerspectiveCamera; never moved by the library
  renderer,
  lat: 36.07,  // reference position (world origin tile)
  lon: -112.1,
});

// in the render loop:
tiles.update();

// helpers:
const { x, z } = tiles.latLonToWorld(lat, lon);
const credits = tiles.attribution(); // display these — provider license terms

tiles.dispose();
```

Options (all optional except `serverUrl`/`scene`/`camera`/`renderer`): `minZoom`, `maxZoom`,
`maxScreenError` (px budget, default 2), `hysteresis`, `maxConcurrentLoads`, `cacheBudget`,
`texelErrorScale`, `fallbackGeometricError`, `rebaseThresholdM`, `updateIntervalMs`, and the
`onLoad` / `onError` / `onProgress` / `onOriginShift` callbacks. See `src/types.ts`.

## Development

```sh
npm install
npm run dev        # serves the demo at /demo/ (expects a tile server on :8080)
npm test           # WebGL-free unit tests (tile math, SSE, selector, LRU, queue)
npm run build      # dist/: ESM bundle + type declarations (three stays external)
```

The demo flies with the keyboard (arrows tilt/yaw, Q/E roll, W/S throttle) and has wireframe /
bounding-box debug toggles; parameters live in the URL query.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or
  <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or <http://opensource.org/licenses/MIT>)

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in
this work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without
any additional terms or conditions.
