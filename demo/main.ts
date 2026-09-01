import {
  AmbientLight,
  Box3,
  Box3Helper,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OpenTiles, type TileCoord } from '../src/index';

// ---------------------------------------------------------------------------
// parameters: URL query → inputs; "Load" writes them back and reloads

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const defaults: Record<string, string> = {
  server: 'http://127.0.0.1:8080',
  lat: '36.07',
  lon: '-112.10',
  height: '30000',
  minZoom: '9',
  maxZoom: '17',
  maxError: '2',
};
for (const key of Object.keys(defaults))
  $<HTMLInputElement>(key).value = params.get(key) ?? defaults[key]!;
$<HTMLInputElement>('wire').checked = params.has('wire');
$<HTMLInputElement>('boxes').checked = params.has('boxes');
$('load').onclick = () => {
  const p = new URLSearchParams();
  for (const key of Object.keys(defaults)) {
    const v = $<HTMLInputElement>(key).value;
    if (v !== '') p.set(key, v);
  }
  if ($<HTMLInputElement>('wire').checked) p.set('wire', '');
  if ($<HTMLInputElement>('boxes').checked) p.set('boxes', '');
  location.search = p.toString();
};
const num = (id: string) => Number($<HTMLInputElement>(id).value);

// ---------------------------------------------------------------------------
// scene

const scene = new Scene();
scene.background = new Color(0x1d2733);
const camera = new PerspectiveCamera(50, innerWidth / innerHeight, 2, 10_000_000);
const renderer = new WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

scene.add(new AmbientLight(0xffffff, 1.1));
const sun = new DirectionalLight(0xffffff, 1.8);
sun.position.set(0.6, 1.0, 0.4);
scene.add(sun);

// ---------------------------------------------------------------------------
// the terrain layer

const tiles = new OpenTiles({
  serverUrl: $<HTMLInputElement>('server').value.replace(/\/$/, ''),
  scene,
  camera,
  renderer,
  lat: num('lat'),
  lon: num('lon'),
  minZoom: num('minZoom'),
  maxZoom: num('maxZoom'),
  maxScreenError: num('maxError'),
  onOriginShift: ({ x, z }) => {
    camera.position.x -= x;
    camera.position.z -= z;
  },
  onError: (tile, err) => console.warn('tile failed', tile, err),
});

// start above the configured position looking down at ~45°
{
  const start = tiles.latLonToWorld(num('lat'), num('lon'));
  const h = num('height');
  camera.position.set(start.x, h, start.z + h);
  camera.lookAt(start.x, 0, start.z);
}

// ---------------------------------------------------------------------------
// flight controls: held keys rotate around the camera's own axes; W/S scale
// the forward velocity exponentially (S below the minimum stops dead)

const ROT_SPEED = 0.9;
const MIN_SPEED = 30;
const MAX_SPEED = 300_000;
let speed = 0;
const keys = new Set<string>();
const FLIGHT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyW', 'KeyS']);
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || !FLIGHT_KEYS.has(e.code)) return;
  keys.add(e.code);
  e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function fly(dt: number): void {
  if (keys.has('ArrowUp')) camera.rotateX(ROT_SPEED * dt);
  if (keys.has('ArrowDown')) camera.rotateX(-ROT_SPEED * dt);
  if (keys.has('ArrowLeft')) camera.rotateY(ROT_SPEED * dt);
  if (keys.has('ArrowRight')) camera.rotateY(-ROT_SPEED * dt);
  if (keys.has('KeyQ')) camera.rotateZ(ROT_SPEED * 1.3 * dt);
  if (keys.has('KeyE')) camera.rotateZ(-ROT_SPEED * 1.3 * dt);
  if (keys.has('KeyW')) speed = speed ? Math.min(speed * 2 ** (dt * 1.5), MAX_SPEED) : MIN_SPEED;
  if (keys.has('KeyS')) {
    speed *= 2 ** (-dt * 1.5);
    if (speed < MIN_SPEED) speed = 0;
  }
  if (speed) camera.translateZ(-speed * dt);
}

// ---------------------------------------------------------------------------
// debug overlays: per-zoom wireframe tint + tile bounding boxes, applied over
// the library's public `group` (tiles carry `userData.tile` / `userData.edge`)

const wireMats = new Map<number, MeshBasicMaterial>();
const wireMat = (z: number) => {
  let m = wireMats.get(z);
  if (!m) {
    m = new MeshBasicMaterial({
      wireframe: true,
      color: new Color().setHSL(((z - num('minZoom')) * 0.13) % 1, 0.9, 0.6),
    });
    wireMats.set(z, m);
  }
  return m;
};

const debugGroup = new Group();
scene.add(debugGroup);

function syncDebug(): void {
  const wire = $<HTMLInputElement>('wire').checked;
  const boxes = $<HTMLInputElement>('boxes').checked;
  debugGroup.clear();
  for (const child of tiles.group.children) {
    const t = child.userData.tile as TileCoord | undefined;
    if (!t) continue;
    child.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      if (o.userData.origMaterial === undefined) o.userData.origMaterial = o.material;
      o.material = wire ? wireMat(t.z) : o.userData.origMaterial;
    });
    if (boxes && child.visible) {
      const box = new Box3().setFromObject(child);
      debugGroup.add(new Box3Helper(box, wireMat(t.z).color));
    }
  }
}

// ---------------------------------------------------------------------------
// HUD + attribution

const hud = $('hud');
let frames = 0;
let fps = 0;
let fpsAt = performance.now();

function refreshHud(): void {
  const perZoom = new Map<number, number>();
  for (const child of tiles.group.children) {
    const t = child.userData.tile as TileCoord | undefined;
    if (t && child.visible) perZoom.set(t.z, (perZoom.get(t.z) ?? 0) + 1);
  }
  const zooms =
    [...perZoom.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([z, n]) => `z${z}:${n}`)
      .join(' ') || 'none';
  const geo = tiles.worldToLatLon(camera.position.x, camera.position.z);
  hud.textContent =
    `tiles ${zooms}\n` +
    `speed ${speed.toFixed(0)} m/s · ${fps} fps\n` +
    `lat ${geo.lat.toFixed(4)} lon ${geo.lon.toFixed(4)} h ${camera.position.y.toFixed(0)} m`;
  $('attrib').textContent = tiles.attribution().join(' · ') || 'loading…';
}

setInterval(() => {
  refreshHud();
  syncDebug();
}, 500);

// ---------------------------------------------------------------------------
// main loop

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  fly(Math.min((now - last) / 1000, 0.1));
  last = now;
  if (!$<HTMLInputElement>('freeze').checked) tiles.update();
  renderer.render(scene, camera);
  frames++;
  if (now - fpsAt > 1000) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
  }
});
