import * as THREE from 'three';

/** Small deterministic generator, so the island looks the same on every visit. */
export function makeRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

export interface Toolkit {
  ramp: THREE.DataTexture;
  mat(color: string): THREE.MeshToonMaterial;
  box(w: number, h: number, d: number): THREE.BoxGeometry;
  cyl(top: number, bottom: number, height: number, segments?: number): THREE.CylinderGeometry;
  sph(radius: number, segments?: number): THREE.SphereGeometry;
  cone(radius: number, height: number, segments?: number): THREE.ConeGeometry;
  add(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: string | THREE.Material,
    x?: number,
    y?: number,
    z?: number,
    rx?: number,
    ry?: number,
    rz?: number,
  ): THREE.Mesh;
  /** Frees geometries (and own materials) below `root`. Shared toolkit materials are kept alive. */
  disposeTree(root: THREE.Object3D, keep: THREE.Material[]): void;
}

export function createToolkit(Toon: typeof THREE.MeshToonMaterial): Toolkit {
  const ramp = new THREE.DataTexture(new Uint8Array([110, 175, 235, 255]), 4, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  const cache = new Map<string, THREE.MeshToonMaterial>();
  const mat = (color: string) => {
    let m = cache.get(color);
    if (!m) {
      m = new Toon({ color, gradientMap: ramp });
      cache.set(color, m);
    }
    return m;
  };
  return {
    ramp,
    mat,
    box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
    cyl: (a, b, h, n = 12) => new THREE.CylinderGeometry(a, b, h, n),
    sph: (r, n = 14) => new THREE.SphereGeometry(r, n, Math.max(8, n - 4)),
    cone: (r, h, n = 10) => new THREE.ConeGeometry(r, h, n),
    add(parent, geometry, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
      const m = new THREE.Mesh(geometry, typeof material === 'string' ? mat(material) : material);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
      return m;
    },
    disposeTree(root, keep) {
      const shared = new Set<THREE.Material>([...cache.values(), ...keep]);
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        (o.geometry as THREE.BufferGeometry).dispose();
        const m = o.material as THREE.Material;
        // ShaderMaterials here are the shared sky/ink/pond materials, owned by the scene
        if (!shared.has(m) && !(m instanceof THREE.ShaderMaterial)) m.dispose();
      });
      if (root instanceof THREE.Scene) for (const m of cache.values()) m.dispose();
    },
  };
}

/** Hip roof with upswept corners: concave slope, eaves that lift towards the corners. */
export function roofGeometry(w: number, d: number, h: number, over: number): THREE.BufferGeometry {
  const rings = 10;
  const around = 24;
  const W = w / 2 + over;
  const D = d / 2 + over;
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const;
  const verts: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const s = 1 - t;
    const y = h * Math.pow(t, 1.7);
    const rx = W * s + w * 0.22 * t;
    const rz = D * s + 0.02;
    for (let k = 0; k < around; k++) {
      const q = k / 6;
      const side = Math.floor(q);
      const f = q - side;
      const A = corners[side as 0 | 1 | 2 | 3];
      const B = corners[((side + 1) % 4) as 0 | 1 | 2 | 3];
      const lift = Math.pow(Math.abs(f - 0.5) * 2, 3) * 0.32 * s;
      verts.push((A[0] + (B[0] - A[0]) * f) * rx, y + lift, (A[1] + (B[1] - A[1]) * f) * rz);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < around; k++) {
      const a = i * around + k;
      const b = i * around + ((k + 1) % around);
      index.push(a, a + around, b, b, a + around, b + around);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}
