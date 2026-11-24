import * as THREE from 'three';
import type { IslandView, PagodaFloor } from '../lib/island';
import type { IslandEvent } from './bus';
import { createToolkit, makeRandom, roofGeometry, type Toolkit } from './toolkit';

/**
 * The floating island behind the app. Framework-free: React only creates it, feeds it data and
 * events, and disposes it. Everything is built from primitives, so there are no model downloads.
 */

export type PinId = 'library' | 'review' | 'kana' | 'progress';
export type PinPositions = Record<PinId, { x: number; y: number }>;

export interface IslandOptions {
  light: boolean;
  reducedMotion: boolean;
  onPins?: (pins: PinPositions) => void;
}

export interface IslandHandle {
  setView(view: IslandView, opts: { dockWidth: number; wide: boolean; hidden: boolean }): void;
  setData(data: { floors: PagodaFloor[]; blossoms: number }): void;
  setTime(t: number): void;
  event(e: IslandEvent): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

const INK = '#2b2438';
const VERMILION = '#d9452c';
const ROOF = '#4a5a7d';
const WOOD = '#6b4530';
const WALL = '#f5ecd9';
const STONE = '#b3a89d';
const DARK = '#2c2733';

interface SkyKey {
  t: number;
  a: THREE.Color;
  b: THREE.Color;
  c: THREE.Color;
  sun: THREE.Color;
  si: number;
  hemi: number;
  night: number;
  pos: [number, number, number];
  cloud: THREE.Color;
}

interface CamPose {
  p: [number, number, number];
  d: number;
  r: number;
  e: number;
}

const CAMS: Record<IslandView, CamPose> = {
  home: { p: [0, 0.6, 0], d: 35, r: 0.35, e: 0.3 },
  library: { p: [5.2, 3.6, -3.4], d: 21, r: 0.62, e: 0.2 },
  review: { p: [-2.9, 2.0, 0.4], d: 19.5, r: 0.1, e: 0.19 },
  kana: { p: [-5.2, 1.9, 3.8], d: 13.5, r: 0.1, e: 0.18 },
  progress: { p: [0.9, 2.9, -0.6], d: 18, r: 0.2, e: 0.14 },
  away: { p: [0, 1.5, 0], d: 46, r: -0.5, e: 0.18 },
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function createIsland(canvas: HTMLCanvasElement, options: IslandOptions): IslandHandle {
  // Colours are authored in display space; keep three from converting them a second time.
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !options.light,
    powerPreference: options.light ? 'low-power' : 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = !options.light;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const rnd = makeRandom(5);
  const kit: Toolkit = createToolkit(THREE.MeshToonMaterial);
  const { add, box, cyl, sph, cone, mat, ramp } = kit;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 55, 130);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.5, 300);
  const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // ---------------------------------------------------------------- sky + light
  const skyU = {
    a: { value: new THREE.Color() },
    b: { value: new THREE.Color() },
    c: { value: new THREE.Color() },
    n: { value: 0 },
    t: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(150, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: skyU,
      vertexShader: /* glsl */ `varying vec3 d;
        void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `varying vec3 d; uniform vec3 a, b, c; uniform float n, t;
        float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
        void main(){
          float h = normalize(d).y;
          vec3 k = mix(c, b, smoothstep(-.55, -.05, h));
          k = mix(k, a, smoothstep(-.1, .55, h));
          vec2 q = vec2(atan(d.x, d.z), h) * 34.;
          float s = step(.975, hash(floor(q)));
          k += n * s * smoothstep(.2, .0, length(fract(q)-.5)) * (.6 + .4*sin(t*2. + q.x));
          gl_FragColor = vec4(pow(k, vec3(.4545)), 1.);
        }`,
    }),
  );
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffffff, Math.PI);
  sun.castShadow = !options.light;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -13,
    right: 13,
    top: 13,
    bottom: -13,
    near: 1,
    far: 60,
  });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, Math.PI / 2);
  scene.add(sun, sun.target, hemi);
  const nightLights: THREE.PointLight[] = [];
  const lampAt = (x: number, y: number, z: number, power: number, dist: number) => {
    const l = new THREE.PointLight(0xffa850, 0, dist, 1.4);
    l.position.set(x, y, z);
    l.userData.power = power;
    isl.add(l);
    nightLights.push(l);
  };

  // ---------------------------------------------------------------- ground
  const isl = new THREE.Group();
  scene.add(isl);
  const rockMat = new THREE.MeshStandardMaterial({
    color: '#8d7a86',
    flatShading: true,
    roughness: 1,
  });
  const rockG = new THREE.CylinderGeometry(9.4, 0.8, 9.5, 36, 12);
  {
    const p = rockG.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const a = Math.atan2(z, x);
      const k = (4.75 - y) / 9.5;
      const f =
        1 +
        (Math.sin(a * 5 + y) * 0.07 + Math.sin(a * 11 + y * 2.3) * 0.05) * (0.3 + k) +
        (k > 0 && k < 1 ? Math.sin(y * 3.1) * 0.05 : 0);
      p.setXYZ(i, x * f, y - (k > 0.99 ? Math.sin(a * 3) : 0), z * f);
    }
    rockG.computeVertexNormals();
  }
  add(isl, rockG, rockMat, 0, -5.15, 0);
  const grassG = new THREE.CylinderGeometry(9.7, 9.3, 0.9, 64, 1);
  {
    const p = grassG.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getZ(i), p.getX(i));
      if (Math.hypot(p.getX(i), p.getZ(i)) > 1) {
        const f = 1 + Math.sin(a * 5) * 0.035 + Math.sin(a * 9 + 1) * 0.025;
        p.setX(i, p.getX(i) * f);
        p.setZ(i, p.getZ(i) * f);
      }
    }
    grassG.computeVertexNormals();
  }
  add(isl, grassG, '#7fb764', 0, -0.45, 0);
  add(isl, cyl(9.5, 8.6, 0.8, 40), '#b98d68', 0, -0.95, 0);
  const hill = add(
    isl,
    new THREE.SphereGeometry(4.6, 32, 12, 0, 6.3, 0, 1.2),
    '#8fc56d',
    -3.6,
    -2.25,
    -4.3,
  );
  hill.scale.set(1, 0.95, 0.9);
  hill.userData.noOutline = true;

  // ---------------------------------------------------------------- pond, koi, bridge
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(2.9, 48),
    new THREE.ShaderMaterial({
      uniforms: { t: skyU.t, n: skyU.n },
      vertexShader:
        'varying vec2 u; void main(){ u = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: /* glsl */ `varying vec2 u; uniform float t, n;
        float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec2 p = (u-.5)*7.;
          float w = vn(p*2.2+vec2(t*.35,0.)) + vn(p*3.1-vec2(0.,t*.28));
          float e = smoothstep(.40, .49, length(u-.5));
          vec3 k = mix(vec3(.25,.66,.72), vec3(.42,.80,.80), e);
          k = mix(k, vec3(.95), smoothstep(1.12,1.16,w)*.75);
          k = mix(k, vec3(.95,1.,.96), step(.475, length(u-.5)));
          gl_FragColor = vec4(mix(k, k*vec3(.22,.32,.60), n), 1.);
        }`,
    }),
  );
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(3.3, 0.03, 4.2);
  pond.scale.set(1.25, 0.9, 1);
  pond.userData.noOutline = true;
  isl.add(pond);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * 6.283;
    add(
      isl,
      new THREE.DodecahedronGeometry(0.22 + rnd() * 0.2),
      i % 3 ? '#a7a2ad' : '#8d8a97',
      3.3 + Math.cos(a) * 3.65,
      0.05,
      4.2 + Math.sin(a) * 2.65,
      rnd(),
      rnd(),
    );
  }
  const koi = ['#f26a3d', '#ffffff', '#f7a13d', '#f26a3d'].map((c) => {
    const g = new THREE.Group();
    add(g, sph(0.2), c).scale.set(0.55, 0.35, 1.2);
    add(g, cone(0.15, 0.3, 4), c, 0, 0, -0.32, Math.PI / 2).scale.x = 0.4;
    isl.add(g);
    return g;
  });
  for (let i = 0; i < 13; i++) {
    const a = (i / 12 - 0.5) * 2;
    add(
      isl,
      box(1.1, 0.12, 0.5),
      VERMILION,
      3.3,
      0.1 + (1 - a * a) * 0.65,
      4.2 + a * 2.9,
      a * 0.42,
    );
  }
  for (const x of [-0.55, 0.55]) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 6 - 0.5) * 2;
      add(
        isl,
        cyl(0.06, 0.06, 0.6, 6),
        '#b8321e',
        3.3 + x,
        0.4 + (1 - a * a) * 0.65,
        4.2 + a * 2.9,
      );
    }
    for (let i = 0; i < 12; i++) {
      const a = ((i + 0.5) / 12 - 0.5) * 2;
      add(
        isl,
        box(0.09, 0.09, 0.52),
        VERMILION,
        3.3 + x,
        0.67 + (1 - a * a) * 0.65,
        4.2 + a * 2.9,
        a * 0.42,
      );
    }
  }

  // ---------------------------------------------------------------- buildings
  const roofMat = new THREE.MeshToonMaterial({
    color: ROOF,
    gradientMap: ramp,
    side: THREE.DoubleSide,
  });
  const putRoof = (p: THREE.Object3D, w: number, d: number, h: number, y: number, over: number) => {
    const r = new THREE.Mesh(roofGeometry(w, d, h, over), roofMat);
    r.position.y = y;
    r.castShadow = r.receiveShadow = true;
    p.add(r);
    add(p, box(w * 0.5, 0.16, 0.2), '#39435c', 0, y + h + 0.02, 0);
  };
  const windowMat = new THREE.MeshBasicMaterial({ color: '#fff0c4' });
  const lampMat = new THREE.MeshBasicMaterial({ color: '#ffd27a' });

  // dojo = review
  const dojo = new THREE.Group();
  dojo.position.set(-3.5, 1.78, -4.4);
  dojo.rotation.y = 0.45;
  isl.add(dojo);
  add(dojo, box(5, 0.35, 3.8), '#9a7b62');
  add(dojo, box(4, 1.7, 2.9), WALL, 0, 1, 0);
  for (const x of [-2, -0.67, 0.67, 2])
    for (const z of [-1.46, 1.46]) add(dojo, box(0.2, 1.75, 0.2), WOOD, x, 1, z);
  for (const x of [-1.33, 0, 1.33]) {
    add(dojo, box(1.08, 1.35, 0.05), windowMat, x, 0.95, 1.47);
    for (let k = -1; k <= 1; k++) {
      add(dojo, box(0.04, 1.35, 0.07), WOOD, x + k * 0.34, 0.95, 1.48);
      add(dojo, box(1.08, 0.04, 0.07), WOOD, x, 0.95 + k * 0.38, 1.48);
    }
  }
  putRoof(dojo, 4.2, 3.2, 1.75, 1.85, 0.85);
  for (let i = 0; i < 3; i++)
    add(dojo, box(1.5, 0.18, 0.4), STONE, 0, -0.2 - i * 0.2, 2.1 + i * 0.38);

  // pagoda = library, rebuilt when the number of anime changes
  const pagoda = new THREE.Group();
  pagoda.position.set(5.2, 0, -3.4);
  pagoda.rotation.y = -0.35;
  isl.add(pagoda);
  let floors: Array<{ group: THREE.Group; glow: THREE.MeshBasicMaterial; animeId: number | null }> =
    [];
  let pagodaTop = 8.6;
  function buildPagoda(list: PagodaFloor[]): void {
    kit.disposeTree(pagoda, [roofMat]);
    pagoda.clear();
    floors = [];
    add(pagoda, box(3.2, 0.4, 3.2), STONE, 0, 0.2, 0);
    const n = list.length;
    const step = n > 4 ? 1.5 : 1.62;
    list.forEach((fl, i) => {
      const w = 2.3 - i * (n > 4 ? 0.25 : 0.3);
      const f = new THREE.Group();
      f.position.y = 0.4 + i * step;
      pagoda.add(f);
      add(f, box(w, 1, w), WALL, 0, 0.5, 0);
      for (const a of [-1, 1])
        for (const b of [-1, 1])
          add(f, box(0.16, 1.02, 0.16), '#c83c24', (a * w) / 2, 0.5, (b * w) / 2);
      const glow = new THREE.MeshBasicMaterial({ color: '#fff0c4' });
      for (const [a, b] of [
        [0, 1],
        [1, 0],
        [-1, 0],
        [0, -1],
      ] as const) {
        add(
          f,
          box(a ? 0.05 : w * 0.55, 0.55, b ? 0.05 : w * 0.55),
          glow,
          (a * w) / 2,
          0.5,
          (b * w) / 2,
        );
      }
      putRoof(f, w, w, 0.72, 0.95, 0.75);
      floors.push({ group: f, glow, animeId: fl.animeId });
    });
    const top = 0.4 + n * step;
    add(pagoda, cyl(0.06, 0.1, 1.5, 8), '#d8a63a', 0, top + 0.42, 0);
    for (let i = 0; i < 3; i++) {
      add(
        pagoda,
        new THREE.TorusGeometry(0.22 - i * 0.04, 0.05, 6, 14),
        '#d8a63a',
        0,
        top + 0.07 + i * 0.28,
        0,
        Math.PI / 2,
      );
    }
    pagodaTop = top + 1.7;
    outline(pagoda);
  }

  // bell = kana
  const bell = new THREE.Group();
  bell.position.set(-5.6, 0, 3.2);
  bell.rotation.y = 0.5;
  isl.add(bell);
  add(bell, box(2.4, 0.5, 2.4), STONE, 0, 0.25, 0);
  for (const a of [-1, 1])
    for (const b of [-1, 1]) add(bell, cyl(0.11, 0.13, 2.3, 8), WOOD, a * 0.85, 1.6, b * 0.85);
  putRoof(bell, 2, 2, 1.1, 2.7, 0.65);
  const bellBody = new THREE.Group();
  bellBody.position.y = 2.5;
  bell.add(bellBody);
  add(bellBody, cyl(0.34, 0.5, 1, 18), '#4d8f7b', 0, -0.75, 0);
  add(bellBody, sph(0.34), '#4d8f7b', 0, -0.26, 0);
  add(bellBody, new THREE.TorusGeometry(0.5, 0.06, 8, 20), '#3c7565', 0, -1.24, 0, Math.PI / 2);

  // torii + path
  const torii = new THREE.Group();
  torii.position.set(1.5, 0, 8.05);
  isl.add(torii);
  for (const a of [-1, 1]) {
    add(torii, cyl(0.16, 0.2, 2.8), VERMILION, a * 1.15, 1.4, 0, 0, 0, a * 0.04);
    add(torii, cyl(0.25, 0.27, 0.35), DARK, a * 1.2, 0.17, 0);
  }
  add(torii, box(2.9, 0.17, 0.18), VERMILION, 0, 2.2, 0);
  const kasagi = new THREE.BoxGeometry(3.6, 0.2, 0.36, 16);
  {
    const q = kasagi.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < q.count; i++)
      q.setY(i, q.getY(i) + Math.pow(Math.abs(q.getX(i) / 1.8), 2.4) * 0.22);
    kasagi.computeVertexNormals();
  }
  add(torii, kasagi, DARK, 0, 2.78, 0);
  add(torii, box(3.1, 0.14, 0.26), VERMILION, 0, 2.62, 0);
  for (let i = 0; i < 15; i++) {
    const k = i / 14;
    add(
      isl,
      cyl(0.42 + rnd() * 0.12, 0.45, 0.12, 8),
      '#d6d0c6',
      1.2 - k * 3.2 + Math.sin(k * 5) * 0.5,
      0.03,
      7.4 - k * 8.2,
    );
  }

  // ---------------------------------------------------------------- sakura (one blossom per word)
  const tree = new THREE.Group();
  tree.position.set(0.9, 0, -0.6);
  isl.add(tree);
  const limb = (a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number) => {
    const d = b.clone().sub(a);
    const m = add(tree, cyl(r1, r0, d.length(), 8), '#6d4a43');
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(v3(0, 1, 0), d.normalize());
  };
  limb(v3(0, -0.1, 0), v3(0.15, 1.5, 0.1), 0.5, 0.36);
  limb(v3(0.15, 1.4, 0.1), v3(-0.3, 2.7, -0.1), 0.36, 0.26);
  const tips = (
    [
      [-1.9, 3.9, 0.3],
      [1.5, 3.7, 0.7],
      [0.2, 4.5, -1.2],
      [-0.5, 4.1, 1.4],
      [1, 4.8, -0.2],
      [-1.2, 4.7, -0.8],
    ] as const
  ).map(([x, y, z]) => v3(x, y, z));
  const canopy: THREE.Mesh[] = [];
  for (const b of tips) {
    limb(v3(-0.25, 2.5, -0.1), b, 0.2, 0.08);
    for (const k of [0, 1]) {
      const m = add(
        tree,
        new THREE.IcosahedronGeometry(0.95 - k * 0.28, 1),
        k ? '#ffc5d3' : '#f7a3bb',
        b.x + (k ? rnd() - 0.5 : 0) * 1.3,
        b.y + k * 0.55,
        b.z + (k ? rnd() - 0.5 : 0) * 1.3,
      );
      m.scale.y = 0.72;
      canopy.push(m);
    }
  }
  const dummy = new THREE.Object3D();
  const blossomG = new THREE.CircleGeometry(0.13, 5);
  const blossomM = new THREE.MeshToonMaterial({
    color: '#ffe3ea',
    gradientMap: ramp,
    side: THREE.DoubleSide,
  });
  let blossoms: THREE.InstancedMesh | null = null;
  function buildBlossoms(count: number): void {
    if (blossoms) {
      tree.remove(blossoms);
      blossoms.dispose();
      blossoms = null;
    }
    // young trees are small: the canopy grows with the first few hundred words
    const grow = 0.5 + 0.5 * Math.min(1, Math.sqrt(count / 300));
    for (const m of canopy) m.scale.set(grow, 0.72 * grow, grow);
    if (count === 0) return;
    const r2 = makeRandom(11);
    const mesh = new THREE.InstancedMesh(blossomG, blossomM, count);
    for (let i = 0; i < count; i++) {
      const c = tips[i % tips.length]!;
      const th = r2() * 6.283;
      const ph = Math.acos(1 - 2 * r2());
      const r = (0.95 + r2() * 0.35) * grow;
      dummy.position.set(
        c.x + Math.sin(ph) * Math.cos(th) * r,
        c.y + 0.15 + Math.cos(ph) * r * 0.85,
        c.z + Math.sin(ph) * Math.sin(th) * r,
      );
      dummy.lookAt(c);
      dummy.scale.setScalar((0.7 + r2() * 0.6) * (count > 700 ? 0.85 : 1));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.castShadow = true;
    tree.add(mesh);
    blossoms = mesh;
    dummy.rotation.set(0, 0, 0);
  }

  // ---------------------------------------------------------------- pines, grass, lanterns
  (
    [
      [-7.4, -1.2],
      [-7.6, 0.6],
      [7.6, -0.2],
      [7.9, 1.1],
      [-0.6, -8.1],
      [1.8, -7.6],
      [3.2, -7.4],
      [-6.9, -4.6],
      [8, -2.2],
    ] as const
  ).forEach(([x, z], i) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(0.8 + rnd() * 0.4);
    g.rotation.y = rnd() * 6;
    add(g, cyl(0.13, 0.2, 1.4, 7), '#6d4a43', 0, 0.6, 0, 0, 0, 0.1);
    for (const [cx, cy, cz, r] of [
      [0, 1.5, 0, 0.95],
      [0.4, 2.1, 0.2, 0.72],
      [-0.2, 2.65, -0.1, 0.55],
    ] as const) {
      add(
        g,
        new THREE.IcosahedronGeometry(r, 1),
        i % 2 ? '#3f7a5a' : '#4c8c62',
        cx,
        cy,
        cz,
      ).scale.y = 0.5;
    }
    isl.add(g);
  });
  const tufts = new THREE.InstancedMesh(cone(0.06, 0.32, 4), mat('#a5d47f'), 420);
  for (let i = 0; i < 420; i++) {
    let x = 0;
    let z = 0;
    do {
      const a = rnd() * 6.283;
      const r = Math.sqrt(rnd()) * 8.8;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
    } while (
      Math.hypot((x - 3.3) / 3.9, (z - 4.2) / 2.9) < 1 ||
      Math.hypot(x + 3.6, z + 4.3) < 4.4
    );
    dummy.position.set(x, 0.1, z);
    dummy.rotation.set(0, rnd() * 6, (rnd() - 0.5) * 0.4);
    dummy.scale.setScalar(0.7 + rnd());
    dummy.updateMatrix();
    tufts.setMatrixAt(i, dummy.matrix);
  }
  tufts.receiveShadow = true;
  isl.add(tufts);
  for (const [x, z] of [
    [-6.4, 5],
    [3.4, 7.6],
    [-2.9, 1.2],
    [3.4, -0.6],
  ] as const) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    add(g, cyl(0.13, 0.22, 0.75, 8), '#aaa4ad', 0, 0.37, 0);
    add(g, box(0.42, 0.36, 0.42), lampMat, 0, 0.92, 0);
    add(g, cone(0.48, 0.32, 4), '#8d8a97', 0, 1.26, 0, 0, Math.PI / 4);
    isl.add(g);
    if (!options.light) lampAt(x, 1.1, z, 5, 7);
  }
  lampAt(-2.2, 2.9, -1.4, 10, 9);
  lampAt(4.2, 2.6, -0.8, 10, 10);

  // ---------------------------------------------------------------- the sensei and the cat
  const sensei = new THREE.Group();
  sensei.position.set(-3.1, 0, 6.3);
  sensei.scale.setScalar(1.62);
  isl.add(sensei);
  const body = new THREE.Group();
  sensei.add(body);
  add(body, cyl(0.32, 0.62, 0.95, 18), '#35507a', 0, 0.5, 0);
  add(body, cyl(0.63, 0.66, 0.1, 18), '#29405f', 0, 0.06, 0);
  add(body, new THREE.TorusGeometry(0.5, 0.07, 8, 24), '#e0b44a', 0, 0.48, 0, Math.PI / 2);
  add(body, box(0.1, 0.5, 0.04), WALL, 0.09, 0.78, 0.36, -0.28, 0, 0.45);
  add(body, box(0.1, 0.5, 0.04), WALL, -0.09, 0.78, 0.36, -0.28, 0, -0.45);
  const arm = (s: 1 | -1) => {
    const g = new THREE.Group();
    g.position.set(s * 0.42, 0.82, 0.05);
    body.add(g);
    add(g, cyl(0.13, 0.22, 0.55, 10), '#3d5c8c', s * 0.12, -0.2, 0.06, -0.25, 0, s * 0.5);
    add(g, sph(0.12), '#f2c9a4', s * 0.25, -0.46, 0.12);
    return g;
  };
  const armL = arm(-1);
  const armR = arm(1);
  add(armR, cyl(0.045, 0.05, 2, 8), '#8a5a3a', 0.28, -0.1, 0.16);
  const head = new THREE.Group();
  head.position.set(0, 1.22, 0.03);
  body.add(head);
  add(head, sph(0.4, 22), '#f2c9a4').scale.set(1, 0.95, 0.96);
  const eyes = [-0.14, 0.14].map((x) => {
    const e = add(head, sph(0.052, 10), '#1f1a24', x, 0.03, 0.365);
    e.scale.y = 1.25;
    return e;
  });
  for (const x of [-0.15, 0.15])
    add(head, box(0.2, 0.055, 0.06), '#ffffff', x, 0.16, 0.36, 0, 0, x > 0 ? -0.28 : 0.28);
  add(head, sph(0.07), '#eab08a', 0, -0.05, 0.4);
  for (const x of [-0.12, 0.12])
    add(
      head,
      cone(0.075, 0.36, 8),
      '#ffffff',
      x * 1.35,
      -0.15,
      0.36,
      0.1,
      0,
      x > 0 ? 1.95 : -1.95,
    ).scale.z = 0.6;
  add(head, cone(0.27, 0.8, 14), '#ffffff', 0, -0.5, 0.2, Math.PI - 0.15).scale.z = 0.62;
  for (const x of [-0.25, 0.25]) add(head, sph(0.06), '#f0a48c', x, -0.06, 0.32).scale.z = 0.4;
  // the hat throws no shadow, or the face under it would never see the sun
  add(head, cone(0.68, 0.42, 26), '#e2bd72', 0, 0.43, -0.04).castShadow = false;
  add(head, cone(0.4, 0.25, 26), '#cfa557', 0, 0.52, -0.04).castShadow = false;
  add(
    head,
    new THREE.TorusGeometry(0.67, 0.026, 6, 30),
    '#b98d45',
    0,
    0.22,
    -0.04,
    Math.PI / 2,
  ).castShadow = false;

  const cat = new THREE.Group();
  cat.position.set(-4.9, 0, 5.6);
  cat.scale.setScalar(1.05);
  isl.add(cat);
  add(cat, sph(0.32), '#fff6ea', 0, 0.3, 0).scale.set(0.85, 1, 1);
  const catHead = new THREE.Group();
  catHead.position.set(0, 0.72, 0.16);
  cat.add(catHead);
  add(catHead, sph(0.25), '#fff6ea');
  for (const x of [-0.14, 0.14]) {
    add(catHead, cone(0.09, 0.18, 5), x > 0 ? '#e8923c' : '#4a4048', x, 0.23, 0);
    add(catHead, sph(0.03, 8), '#1f1a24', x * 0.65, 0.02, 0.235);
  }
  const tail = add(cat, cyl(0.05, 0.06, 0.6, 8), '#e8923c', 0.1, 0.4, -0.4, 0.7);

  // ---------------------------------------------------------------- ink outlines
  const inkMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { c: { value: new THREE.Color(INK) } },
    vertexShader:
      'void main(){ vec4 m = modelViewMatrix*vec4(position,1.); m.xyz += normalize(normalMatrix*normal)*.0016*-m.z; gl_Position = projectionMatrix*m; }',
    fragmentShader: 'uniform vec3 c; void main(){ gl_FragColor = vec4(c,1.); }',
  });
  function outline(root: THREE.Object3D): void {
    const list: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
      const m = o.material as THREE.Material;
      if (
        o.userData.noOutline ||
        o.userData.outlined ||
        m === inkMat ||
        m.side === THREE.DoubleSide
      )
        return;
      list.push(o);
    });
    for (const o of list) {
      o.userData.outlined = true;
      o.add(new THREE.Mesh(o.geometry, inkMat));
    }
  }
  outline(isl);
  buildPagoda([
    { animeId: null, title: '', pct: 0 },
    { animeId: null, title: '', pct: 0 },
    { animeId: null, title: '', pct: 0 },
  ]);
  buildBlossoms(0);

  // ---------------------------------------------------------------- clouds, islets, petals
  const cloudMat = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: ramp, fog: false });
  const cloudCount = options.light ? 9 : 16;
  const clouds = Array.from({ length: cloudCount }, (_, i) => {
    const g = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const m = new THREE.Mesh(sph(1 + rnd() * 1.2, 12), cloudMat);
      m.position.set((k - 2) * 1.5 + rnd(), rnd() * 0.6, rnd());
      m.scale.y = 0.55;
      g.add(m);
    }
    const r = 17 + rnd() * 24;
    g.scale.setScalar(0.7 + rnd() * 1.1);
    scene.add(g);
    return {
      g,
      a: (i / cloudCount) * 6.283,
      r,
      y: -9 + rnd() * 10 - (r < 22 ? 4 : 0),
      s: 0.012 + rnd() * 0.012,
    };
  });
  const islets = (
    [
      [-15, 1.5, -9, 1.2],
      [15.5, -2.5, -8, 0.95],
      [-13.5, -4.5, 9, 0.75],
    ] as const
  ).map(([x, y, z, s], i) => {
    const g = new THREE.Group();
    add(g, cone(1.7, 3.2, 9), rockMat, 0, -1.6, 0, Math.PI);
    add(g, cyl(1.75, 1.65, 0.35, 14), '#8fc56d', 0, 0.05, 0);
    if (i === 1) {
      for (const a of [-0.5, 0.5]) add(g, cyl(0.09, 0.1, 1.5), VERMILION, a, 0.8, 0);
      add(g, box(1.6, 0.12, 0.2), VERMILION, 0, 1.5, 0);
      add(g, box(1.3, 0.09, 0.12), VERMILION, 0, 1.2, 0);
    } else {
      add(g, cyl(0.1, 0.15, 0.9, 6), '#6d4a43', 0.2, 0.6, 0);
      add(g, new THREE.IcosahedronGeometry(0.8, 1), i ? '#4c8c62' : '#f7a3bb', 0.2, 1.5, 0);
    }
    g.position.set(x, y, z);
    g.scale.setScalar(s);
    scene.add(g);
    return { g, y };
  });
  const PETALS = options.light ? 90 : 260;
  const petals = new THREE.InstancedMesh(
    new THREE.CircleGeometry(0.1, 5),
    new THREE.MeshBasicMaterial({ color: '#ffc2d2', side: THREE.DoubleSide }),
    PETALS,
  );
  petals.frustumCulled = false;
  scene.add(petals);
  const petalSeeds = Array.from({ length: PETALS }, () => [rnd(), rnd(), rnd(), rnd()] as const);

  // ---------------------------------------------------------------- time of day
  const C = (h: string) => new THREE.Color(h).convertSRGBToLinear();
  const keys: SkyKey[] = [
    {
      t: 0,
      a: C('#8fc7f2'),
      b: C('#ffe1d0'),
      c: C('#ffc9c9'),
      sun: C('#ffe6c9'),
      si: 0.74,
      hemi: 0.4,
      night: 0,
      pos: [10, 8, 9],
      cloud: C('#ffffff'),
    },
    {
      t: 0.4,
      a: C('#4ea9ee'),
      b: C('#bfe8fb'),
      c: C('#e9f7ff'),
      sun: C('#fffaf0'),
      si: 0.74,
      hemi: 0.42,
      night: 0,
      pos: [6, 16, 8],
      cloud: C('#ffffff'),
    },
    {
      t: 0.68,
      a: C('#5b6fd6'),
      b: C('#ffb48c'),
      c: C('#ff8f86'),
      sun: C('#ffb37a'),
      si: 0.85,
      hemi: 0.42,
      night: 0.12,
      pos: [-11, 7, 8],
      cloud: C('#fff0ea'),
    },
    {
      t: 1,
      a: C('#0f1440'),
      b: C('#33407f'),
      c: C('#5c5aa0'),
      sun: C('#8fa4ff'),
      si: 0.5,
      hemi: 0.34,
      night: 1,
      pos: [-6, 13, 7],
      cloud: C('#6d74b8'),
    },
  ];
  const white = new THREE.Color(1, 1, 1);
  function applyTime(t: number): void {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1]!.t < t) i++;
    const A = keys[i]!;
    const B = keys[i + 1]!;
    const k = clamp((t - A.t) / (B.t - A.t), 0, 1);
    const night = lerp(A.night, B.night, k);
    skyU.a.value.copy(A.a).lerp(B.a, k);
    skyU.b.value.copy(A.b).lerp(B.b, k);
    skyU.c.value.copy(A.c).lerp(B.c, k);
    skyU.n.value = night;
    sun.color.copy(A.sun).lerp(B.sun, k);
    sun.intensity = lerp(A.si, B.si, k) * Math.PI;
    hemi.intensity = lerp(A.hemi, B.hemi, k) * Math.PI;
    hemi.color.copy(skyU.a.value).lerp(white, 0.55);
    sun.position.set(
      lerp(A.pos[0], B.pos[0], k),
      lerp(A.pos[1], B.pos[1], k),
      lerp(A.pos[2], B.pos[2], k),
    );
    (scene.fog as THREE.Fog).color.copy(skyU.b.value);
    cloudMat.color.copy(A.cloud).lerp(B.cloud, k);
    for (const l of nightLights) l.intensity = night * (l.userData.power as number);
    windowMat.color.set(night > 0.4 ? '#ffd27a' : '#fff0c4');
  }

  // ---------------------------------------------------------------- interaction state
  const ptr = { x: 0, y: 0, tx: 0, ty: 0, down: false, dx: 0, dy: 0 };
  let view: IslandView = 'home';
  let layout = { dockWidth: 0, wide: false, hidden: false };
  let W = 1;
  let H = 1;
  let time = 0.42;
  let timeGoal = 0.42;
  let spin = CAMS.home.r;
  let spinV = 0;
  let tilt = CAMS.home.e;
  let zoom = 0;
  let hop = 0;
  let shake = 0;
  let ring = 0;
  let burst = 0;
  let selected: number | null = null;
  const cur = { p: v3(0, 1, 0), d: 46, r: -0.6, e: 0.55, ox: 0, oy: 0 };
  const goalP = v3(0, 0, 0);
  const tmp = v3(0, 0, 0);

  const onMove = (e: PointerEvent) => {
    const nx = (e.clientX / innerWidth) * 2 - 1;
    const ny = -((e.clientY / innerHeight) * 2 - 1);
    if (ptr.down) {
      ptr.dx += nx - ptr.tx;
      ptr.dy += ny - ptr.ty;
    }
    ptr.tx = nx;
    ptr.ty = ny;
  };
  const onDown = (e: PointerEvent) => {
    ptr.down = e.target === canvas;
    if (ptr.down) hop = 1;
  };
  const onUp = () => {
    ptr.down = false;
  };
  const onWheel = (e: WheelEvent) => {
    if (e.target === canvas && view === 'home') zoom = clamp(zoom + e.deltaY * 0.01, -12, 10);
  };
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerdown', onDown);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: true });

  // ---------------------------------------------------------------- frame
  let T = 0;
  function update(dt: number): void {
    T += dt * (options.reducedMotion ? 0.2 : 1);
    const t = T;
    const e = options.reducedMotion ? 1 : 1 - Math.exp(-dt * 2.6);
    const pk = Math.min(1, dt * 5);
    ptr.x += (ptr.tx - ptr.x) * pk;
    ptr.y += (ptr.ty - ptr.y) * pk;
    time += (timeGoal - time) * e;
    applyTime(time);
    skyU.t.value = t;

    const c = CAMS[view];
    if (ptr.down) {
      spinV = -ptr.dx * 2.2;
      tilt = clamp(tilt - ptr.dy * 0.9, 0.06, 0.9);
    } else {
      spinV *= Math.exp(-dt * 3);
    }
    ptr.dx = ptr.dy = 0;
    spin += spinV;
    if (view === 'home' && !ptr.down && Math.abs(spinV) < 0.001 && !options.reducedMotion) {
      spin += (0.3 + Math.sin(t * 0.14) * 0.22 - spin) * e * 0.25;
    }
    const narrow = W < 900;
    goalP.set(...c.p);
    if (view === 'library' && selected !== null) goalP.y = 1.4 + selected * 1.5;
    cur.p.lerp(goalP, e);
    const dist =
      (c.d + (view === 'home' ? zoom : 0)) *
      (narrow ? (view === 'home' ? 1.28 : 1.35) : 1) *
      (layout.wide ? 1.5 : 1);
    cur.d += (dist - cur.d) * e;
    cur.r += (spin - cur.r) * e;
    cur.e += (tilt - cur.e) * e;
    cur.ox += ((narrow ? 0 : layout.dockWidth / 2) - cur.ox) * e;
    cur.oy +=
      ((narrow && view !== 'home' ? H * 0.28 : view === 'home' ? H * 0.03 : 0) - cur.oy) * e;
    const r = cur.r + ptr.x * 0.06;
    const el = cur.e - ptr.y * 0.04;
    cam.position.set(
      cur.p.x + Math.sin(r) * Math.cos(el) * cur.d,
      cur.p.y + Math.sin(el) * cur.d,
      cur.p.z + Math.cos(r) * Math.cos(el) * cur.d,
    );
    cam.lookAt(cur.p);
    cam.setViewOffset(W, H, cur.ox, cur.oy, W, H);
    sky.position.copy(cam.position);

    isl.position.y = Math.sin(t * 0.6) * 0.14;
    hop *= Math.exp(-dt * 3.2);
    shake *= Math.exp(-dt * 3);
    ring *= Math.exp(-dt * 0.9);
    burst *= Math.exp(-dt * 0.8);

    sensei.position.y = Math.abs(Math.sin(t * 9)) * hop * 0.35;
    body.scale.y = 1 + Math.sin(t * 2) * 0.015;
    body.rotation.y = Math.sin(t * 22) * shake * 0.35;
    const yaw = Math.atan2(cam.position.x - sensei.position.x, cam.position.z - sensei.position.z);
    sensei.rotation.y += (clamp(yaw, -1.2, 1.2) - sensei.rotation.y) * e;
    head.rotation.y += (ptr.x * 0.6 - head.rotation.y) * e;
    head.rotation.x += (-0.42 - ptr.y * 0.22 - head.rotation.x) * e;
    armL.rotation.z = -hop * 1.9 * (0.7 + 0.3 * Math.sin(t * 14));
    const blink = Math.sin(t * 0.9) > 0.985 ? 0.12 : 1.25;
    for (const m of eyes) m.scale.y += (blink - m.scale.y) * 0.4;
    catHead.rotation.y = Math.sin(t * 0.5) * 0.5;
    tail.rotation.z = Math.sin(t * 2) * 0.4;
    bellBody.rotation.z = Math.sin(t * 5) * ring * 0.42;
    koi.forEach((k, i) => {
      const a = t * (0.28 + i * 0.05) + i * 1.6;
      const rr = 1.5 + (i % 2) * 0.6;
      k.position.set(3.3 + Math.cos(a) * rr * 1.2, 0.06, 4.2 + Math.sin(a) * rr * 0.85);
      k.rotation.y = -a + Math.sin(t * 5 + i) * 0.12;
    });
    floors.forEach((f, i) => {
      const on = view === 'library' && f.animeId !== null && (selected === i || selected === null);
      f.glow.color.set(on || skyU.n.value > 0.4 ? '#ffd27a' : '#fff0c4');
      const s = view === 'library' && selected === i ? 1.07 : 1;
      f.group.scale.x += (s - f.group.scale.x) * Math.min(1, e * 2);
      f.group.scale.z = f.group.scale.x;
    });
    for (const k of clouds) {
      const a = k.a + t * k.s;
      k.g.position.set(Math.cos(a) * k.r, k.y, Math.sin(a) * k.r);
    }
    islets.forEach((k, i) => {
      k.g.position.y = k.y + Math.sin(t * 0.5 + i * 2) * 0.4;
      k.g.rotation.y = t * 0.05;
    });
    const calm = Math.round(PETALS * 0.42);
    const spread = 1 + burst * 2.2;
    petalSeeds.forEach((s, i) => {
      const f = (s[1] + t * 0.045 * (0.6 + s[3])) % 1;
      dummy.position.set(
        0.9 + (s[0] - 0.5) * 6 * spread + f * 5 + Math.sin(t + s[3] * 20) * 0.6,
        5.6 - f * 8 + burst * 2 * s[2],
        -0.6 + (s[2] - 0.5) * 6 * spread + Math.cos(t * 0.8 + s[0] * 20) * 0.5,
      );
      dummy.rotation.set(t * (1 + s[0]), t * s[1], s[2] * 6);
      dummy.scale.setScalar(blossoms && (i < calm || burst > 0.05) ? 0.8 + s[3] * 0.8 : 0.0001);
      dummy.updateMatrix();
      petals.setMatrixAt(i, dummy.matrix);
    });
    petals.instanceMatrix.needsUpdate = true;

    renderer.render(scene, cam);
    if (options.onPins && view === 'home') options.onPins(pinPositions());
  }

  const pinAt: Record<PinId, () => THREE.Vector3> = {
    library: () => tmp.set(5.2, pagodaTop, -3.4),
    review: () => tmp.set(-5.0, 6.2, -4.4),
    kana: () => tmp.set(-5.6, 4.6, 3.2),
    progress: () => tmp.set(0.9, 6.7, -0.6),
  };
  function pinPositions(): PinPositions {
    const out = {} as PinPositions;
    for (const id of Object.keys(pinAt) as PinId[]) {
      const p = pinAt[id]();
      p.y += isl.position.y;
      p.project(cam);
      out[id] = { x: ((p.x + 1) / 2) * W, y: Math.max(118, ((1 - p.y) / 2) * H) };
    }
    return out;
  }

  // Full speed where the island is the star, a gentle rate behind dense pages, nothing when hidden.
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    const dt = clamp((now - last) / 1000, 0, 0.1);
    last = now;
    if (document.hidden || layout.hidden) return;
    acc += dt;
    const fps = layout.wide ? 12 : options.light ? 30 : 0;
    if (fps && acc < 1 / fps) return;
    const step = Math.min(acc, 0.1);
    acc = 0;
    update(step);
  }
  raf = requestAnimationFrame(loop);

  return {
    setView(next, opts) {
      if (next !== view) {
        spin = CAMS[next].r;
        tilt = CAMS[next].e;
        spinV = 0;
        hop = 1;
        selected = null;
      }
      view = next;
      layout = opts;
    },
    setData({ floors: list, blossoms: count }) {
      buildPagoda(list);
      buildBlossoms(count);
    },
    setTime(t) {
      timeGoal = t;
    },
    event(ev) {
      if (ev.type === 'time') timeGoal = ev.value;
      if (ev.type === 'reveal') hop = 1;
      if (ev.type === 'rate') {
        if (ev.rating > 1) {
          burst = Math.max(burst, 0.5 + ev.rating * 0.15);
          hop = 1;
        } else shake = 1;
      }
      if (ev.type === 'graduate') {
        burst = 1.6;
        ring = 1;
        hop = 1;
      }
      if (ev.type === 'kana') {
        ring = ev.ok ? 1 : 0.35;
        if (ev.ok) {
          burst = Math.max(burst, 0.8);
          hop = 1;
        } else shake = 1;
      }
      if (ev.type === 'floor') {
        const i = floors.findIndex((f) => f.animeId !== null && f.animeId === ev.animeId);
        selected = i >= 0 ? i : null;
      }
    },
    resize(w, h) {
      W = Math.max(1, w);
      H = Math.max(1, h);
      renderer.setPixelRatio(Math.min(devicePixelRatio, options.light ? 1 : 1.75));
      renderer.setSize(W, H, false);
      cam.aspect = W / H;
      cam.updateProjectionMatrix();
    },
    dispose() {
      cancelAnimationFrame(raf);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerdown', onDown);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      kit.disposeTree(scene, []);
      blossomG.dispose();
      inkMat.dispose();
      ramp.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
    },
  };
}
