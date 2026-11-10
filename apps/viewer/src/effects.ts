// Short-lived highlight effects for live changes: a beam of light on a building, a ripple over an area.
import * as THREE from "three";

const live: { obj: THREE.Object3D; born: number; life: number; tick: (t: number) => void }[] = [];
const ACCENT = new THREE.Color(0x5fd0ff);

export function flashChange(scene: THREE.Scene, o: { x: number; z: number; height?: number; radius: number; area?: boolean }) {
  const group = new THREE.Group();
  group.position.set(o.x, 0, o.z);
  const mats: THREE.MeshBasicMaterial[] = [];
  const mat = (opacity: number) => { const m = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }); mats.push(m); return m; };
  let tick: (t: number) => void;
  if (o.area) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2), mat(0.8));
    ring.position.y = 1; group.add(ring);
    tick = (t) => { const s = o.radius * (0.2 + t * 0.9); ring.scale.set(s, 1, s); mats[0].opacity = 0.8 * (1 - t); };
  } else {
    const h = (o.height ?? 20) + 60;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(o.radius * 0.35, o.radius * 0.6, h, 24, 1, true), mat(0.5));
    beam.position.y = h / 2; group.add(beam);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), mat(0.9));
    ring.position.y = 0.5; group.add(ring);
    tick = (t) => {
      mats[0].opacity = 0.55 * (1 - t) * (0.75 + 0.25 * Math.sin(t * 40));
      const s = o.radius * (1 + t * 5); ring.scale.set(s, 1, s); mats[1].opacity = 0.9 * (1 - t);
    };
  }
  group.renderOrder = 20;
  scene.add(group);
  live.push({ obj: group, born: performance.now(), life: o.area ? 4000 : 7000, tick });
}

/** Call every frame. */
export function updateEffects() {
  const now = performance.now();
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i], t = (now - e.born) / e.life;
    if (t >= 1) {
      e.obj.parent?.remove(e.obj);
      e.obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
      live.splice(i, 1);
    } else e.tick(t);
  }
}
