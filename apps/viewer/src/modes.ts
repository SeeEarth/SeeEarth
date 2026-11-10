// Game-style movement: a third-person walker and a light aircraft. (The free "explore" camera lives in controls.ts.)
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
/** Load a model and normalise it: scaled to `size` metres on its largest/height axis, standing on y=0, centred. */
async function loadNormalised(url: string, size: number, by: "height" | "span") {
  const g = await loader.loadAsync(url);
  const box = new THREE.Box3().setFromObject(g.scene);
  const dims = box.getSize(new THREE.Vector3());
  const s = size / (by === "height" ? dims.y : Math.max(dims.x, dims.z));
  const inner = g.scene;
  inner.scale.multiplyScalar(s);
  const b2 = new THREE.Box3().setFromObject(inner);
  const c = b2.getCenter(new THREE.Vector3());
  inner.position.sub(new THREE.Vector3(c.x, b2.min.y, c.z));
  inner.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; (o as THREE.Mesh).frustumCulled = false; } });
  const holder = new THREE.Group();
  holder.add(inner);
  return { holder, inner, animations: g.animations, dims: b2.getSize(new THREE.Vector3()) };
}

export interface Input {
  keys: Set<string>;
  /** mouse movement since last frame (pointer-locked), in pixels */
  dx: number; dy: number;
}

const has = (i: Input, ...codes: string[]) => codes.some((c) => i.keys.has(c));
/** Frame-rate independent smoothing factor. */
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

// ---------------------------------------------------------------- character

function seg(r0: number, r1: number, len: number, mat: THREE.Material, seg = 10) {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  g.translate(0, -len / 2, 0); // hangs down from its pivot
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}
function ball(r: number, mat: THREE.Material, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
  m.scale.set(sx, sy, sz); m.castShadow = true;
  return m;
}

interface Rig { root: THREE.Group; hips: THREE.Group; torso: THREE.Group; head: THREE.Group;
  thighL: THREE.Group; thighR: THREE.Group; shinL: THREE.Group; shinR: THREE.Group;
  armL: THREE.Group; armR: THREE.Group; foreL: THREE.Group; foreR: THREE.Group }

/** A 1.75 m person with jointed limbs (hips, knees, shoulders, elbows) for a believable walk. */
function makePerson(): Rig {
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a77f, roughness: 0.7 });
  const jacket = new THREE.MeshStandardMaterial({ color: 0x2f5d7c, roughness: 0.85 });
  const jeans = new THREE.MeshStandardMaterial({ color: 0x2d3440, roughness: 0.9 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x3a2a22, roughness: 0.5 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.9 });
  const pack = new THREE.MeshStandardMaterial({ color: 0x8c3b2f, roughness: 0.8 });
  const g = () => new THREE.Group();
  const root = g(), hips = g(), torso = g(), head = g();
  hips.position.y = 0.95; root.add(hips);
  hips.add(ball(0.17, jeans, 1.05, 0.7, 0.75));
  torso.position.y = 0.05; hips.add(torso);
  const chest = seg(0.15, 0.2, 0.52, jacket, 14); chest.position.y = 0.55; chest.scale.z = 0.72; torso.add(chest);
  const shoulders = ball(0.2, jacket, 1.15, 0.5, 0.75); shoulders.position.y = 0.53; torso.add(shoulders);
  const bag = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.38, 0.14), pack); bag.position.set(0, 0.32, 0.16); bag.castShadow = true; torso.add(bag);
  const neck = seg(0.055, 0.05, 0.1, skin); neck.position.y = 0.68; torso.add(neck);
  head.position.y = 0.72; torso.add(head);
  const skull = ball(0.105, skin, 0.92, 1.1, 1); skull.position.y = 0.1; head.add(skull);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
  hairCap.position.y = 0.12; hairCap.scale.set(0.95, 1.05, 1.05); hairCap.rotation.x = 0.15; head.add(hairCap);
  const nose = ball(0.02, skin, 1, 1, 1.4); nose.position.set(0, 0.09, -0.1); head.add(nose);
  const limb = (parent: THREE.Object3D, x: number, y: number) => { const p = g(); p.position.set(x, y, 0); parent.add(p); return p; };
  const thighL = limb(hips, -0.095, -0.02), thighR = limb(hips, 0.095, -0.02);
  for (const t of [thighL, thighR]) t.add(seg(0.085, 0.07, 0.44, jeans));
  const shinL = limb(thighL, 0, -0.44), shinR = limb(thighR, 0, -0.44);
  for (const s of [shinL, shinR]) {
    s.add(seg(0.065, 0.05, 0.42, jeans));
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.26), shoe); foot.position.set(0, -0.45, -0.05); foot.castShadow = true; s.add(foot);
  }
  const armL = limb(torso, -0.24, 0.66), armR = limb(torso, 0.24, 0.66);
  for (const a of [armL, armR]) a.add(seg(0.055, 0.048, 0.3, jacket));
  const foreL = limb(armL, 0, -0.3), foreR = limb(armR, 0, -0.3);
  for (const f of [foreL, foreR]) { f.add(seg(0.046, 0.04, 0.26, jacket)); const hand = ball(0.045, skin, 0.8, 1.2, 0.6); hand.position.y = -0.3; f.add(hand); }
  return { root, hips, torso, head, thighL, thighR, shinL, shinR, armL, armR, foreL, foreR };
}

export class Walker {
  readonly root: THREE.Group;
  private rig: Rig;
  private yaw = 0; private pitch = -0.2;          // camera, smoothed towards targets
  private tYaw = 0; private tPitch = -0.2;
  private facing = 0;
  private vel = new THREE.Vector3();
  private vy = 0;
  private phase = 0;
  private stride = 0;                              // 0 idle … 1 running, smoothed
  private camPos = new THREE.Vector3();
  private ray = new THREE.Raycaster();

  private mixer: THREE.AnimationMixer | null = null;
  private actions: Record<string, THREE.AnimationAction> = {};
  private current = "";

  constructor(private cam: THREE.PerspectiveCamera, private obstacles: () => THREE.Object3D[]) {
    this.rig = makePerson();
    this.root = new THREE.Group();
    this.root.add(this.rig.root);
    this.ray.firstHitOnly = true;
    // Swap in the real animated character if it's available (scripts/fetch-demo-models.sh):
    // the person model, animated with walk/run/idle clips from another model on the same Mixamo skeleton.
    Promise.all([loadNormalised("/models/person.glb", 1.7, "height"), loader.loadAsync("/models/anims.glb")]).then(([{ holder, inner }, anims]) => {
      inner.rotation.y = Math.PI;   // this character faces +Z; turn her to walk away from the camera (−Z)
      this.root.remove(this.rig.root);
      this.root.add(holder);
      this.mixer = new THREE.AnimationMixer(inner);
      for (const clip of anims.animations) {
        // rotations only: the two rigs are scaled differently, so position/scale tracks would distort the body
        // and not the hips: they also carry the rig's overall orientation, which differs between the two files
        const c = new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.filter((t) => t.name.endsWith(".quaternion") && !/Hips\.quaternion$/.test(t.name)));
        this.actions[clip.name.toLowerCase()] = this.mixer.clipAction(c);
      }
      this.play("idle");
    }).catch(() => { /* keep the built-in figure */ });
  }

  private play(name: string) {
    if (name === this.current || !this.actions[name]) return;
    const next = this.actions[name];
    next.reset().setEffectiveWeight(1).fadeIn(0.25).play();
    if (this.current && this.actions[this.current]) this.actions[this.current].fadeOut(0.25);
    this.current = name;
  }

  /** Is this ground point covered by a building (roof found above it)? */
  private covered(x: number, z: number): boolean {
    this.ray.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
    this.ray.far = 399.5;
    return this.ray.intersectObjects(this.obstacles(), false).length > 0;
  }

  /** Nearest open ground to (x, z), searching outwards in rings. */
  private openSpot(x: number, z: number): [number, number] {
    if (!this.covered(x, z)) return [x, z];
    for (let r = 3; r <= 120; r += 3) {
      for (let a = 0; a < 16; a++) {
        const px = x + Math.cos((a / 16) * Math.PI * 2) * r, pz = z + Math.sin((a / 16) * Math.PI * 2) * r;
        if (!this.covered(px, pz)) return [px, pz];
      }
    }
    return [x, z];
  }
  private sinceCheck = 0;

  placeAt(x0: number, z0: number, yaw: number) {
    const [x, z] = this.openSpot(x0, z0);
    this.root.position.set(x, 0, z);
    this.yaw = this.tYaw = this.facing = yaw;
    this.vy = 0; this.vel.set(0, 0, 0);
    this.camPos.set(x - Math.sin(yaw) * 5, 3, z + Math.cos(yaw) * 5);
  }

  private hitDist(from: THREE.Vector3, dir: THREE.Vector3, far: number): number {
    this.ray.set(from, dir); this.ray.far = far;
    const hit = this.ray.intersectObjects(this.obstacles(), false)[0];
    return hit ? hit.distance : Infinity;
  }

  update(dt: number, i: Input) {
    this.tYaw += i.dx * 0.0022;
    this.tPitch = THREE.MathUtils.clamp(this.tPitch - i.dy * 0.0022, -1.1, 0.45);
    this.yaw += (this.tYaw - this.yaw) * damp(25, dt);
    this.pitch += (this.tPitch - this.pitch) * damp(25, dt);
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const want = new THREE.Vector3();
    if (has(i, "KeyW", "ArrowUp")) want.add(fwd);
    if (has(i, "KeyS", "ArrowDown")) want.sub(fwd);
    if (has(i, "KeyD", "ArrowRight")) want.add(right);
    if (has(i, "KeyA", "ArrowLeft")) want.sub(right);
    const running = has(i, "ShiftLeft", "ShiftRight");
    if (want.lengthSq()) want.normalize().multiplyScalar(running ? 6.5 : 2.6);
    // accelerate/decelerate smoothly instead of starting and stopping instantly
    this.vel.lerp(want, damp(this.root.position.y > 0.01 ? 2 : 9, dt));
    const step = this.vel.clone().multiplyScalar(dt);
    if (step.lengthSq() > 1e-8) {
      const chest = this.root.position.clone().setY(this.root.position.y + 1.1);
      const len = step.length(), dir = step.clone().normalize();
      if (this.hitDist(chest, dir, len + 0.35) > len + 0.35) this.root.position.add(step);
      else {
        // slide along the wall: keep whichever axis is free
        for (const ax of [new THREE.Vector3(step.x, 0, 0), new THREE.Vector3(0, 0, step.z)]) {
          const l = ax.length(); if (l < 1e-6) continue;
          if (this.hitDist(chest, ax.clone().normalize(), l + 0.35) > l + 0.35) { this.root.position.add(ax); break; }
        }
        this.vel.multiplyScalar(0.5);
      }
    }
    // a building that loaded after we spawned might now surround us: step out to the street
    if ((this.sinceCheck += dt) > 0.5) {
      this.sinceCheck = 0;
      const p = this.root.position;
      if (p.y < 1 && this.covered(p.x, p.z)) { const [x, z] = this.openSpot(p.x, p.z); p.x = x; p.z = z; this.vel.set(0, 0, 0); }
    }
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > 0.2) {
      const target = Math.atan2(this.vel.x, -this.vel.z);
      const diff = Math.atan2(Math.sin(target - this.facing), Math.cos(target - this.facing));
      this.facing += diff * damp(10, dt);
    }
    // jump & gravity (flat ground)
    const grounded = this.root.position.y <= 0.001;
    if (has(i, "Space") && grounded) this.vy = 4.5;
    this.vy -= 12 * dt;
    this.root.position.y = Math.max(0, this.root.position.y + this.vy * dt);
    if (this.root.position.y === 0) this.vy = Math.max(0, this.vy);
    this.root.rotation.y = -this.facing;
    if (this.mixer) {
      this.play(speed < 0.3 ? "idle" : speed < 4 ? "walk" : "run");
      // match the feet to the ground speed
      if (this.current === "walk") this.actions.walk.timeScale = speed / 1.6;
      if (this.current === "run") this.actions.run.timeScale = speed / 5.5;
      this.mixer.update(dt);
    } else this.animate(dt, speed, grounded);
    // spring-damped third-person camera, pulled in when a wall is in the way
    const head = this.root.position.clone().add(new THREE.Vector3(0, 1.65, 0));
    const back = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const dist = Math.min(4.5, this.hitDist(head, back, 4.5) - 0.3);
    const goal = head.clone().addScaledVector(back, Math.max(0.8, dist)).add(right.clone().multiplyScalar(0.45));
    goal.y = Math.max(0.3, goal.y);
    this.camPos.lerp(goal, damp(14, dt));
    this.cam.position.copy(this.camPos);
    this.cam.lookAt(head.clone().add(right.clone().multiplyScalar(0.45)).add(fwd.clone().multiplyScalar(2)));
  }

  private animate(dt: number, speed: number, grounded: boolean) {
    const r = this.rig;
    this.stride += (Math.min(1, speed / 6.5) - this.stride) * damp(8, dt);
    this.phase += dt * (3 + speed * 1.9);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const amp = 0.25 + this.stride * 0.55;
    const moving = speed > 0.15;
    const k = moving ? 1 : 0;
    r.thighL.rotation.x = s * amp * k; r.thighR.rotation.x = -s * amp * k;
    // knees bend as the leg swings back and through
    r.shinL.rotation.x = Math.max(0, -c) * amp * 1.4 * k + (grounded ? 0 : 0.6);
    r.shinR.rotation.x = Math.max(0, c) * amp * 1.4 * k + (grounded ? 0 : 0.6);
    r.armL.rotation.x = -s * amp * 0.9 * k; r.armR.rotation.x = s * amp * 0.9 * k;
    r.foreL.rotation.x = -(0.25 + this.stride * 0.9) ; r.foreR.rotation.x = -(0.25 + this.stride * 0.9);
    r.armL.rotation.z = 0.08; r.armR.rotation.z = -0.08;
    r.hips.position.y = 0.95 + (moving ? Math.abs(c) * 0.04 * (1 + this.stride) : Math.sin(this.phase * 0.5) * 0.004);
    r.torso.rotation.x = -this.stride * 0.18;          // lean into a run
    r.torso.rotation.y = s * 0.08 * k;                 // counter-rotate shoulders
    r.head.rotation.y = -s * 0.05 * k;
  }

  get position() { return this.root.position; }
}

// ---------------------------------------------------------------- aircraft

/** A high-wing light aircraft (Cessna-like), about 8 m long and 11 m wingspan, nose towards −Z. */
function makeAircraft(): { root: THREE.Group; prop: THREE.Group; disc: THREE.Mesh; blades: THREE.Group } {
  const paint = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.35, metalness: 0.15 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x1f5f87, roughness: 0.4, metalness: 0.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2632, roughness: 0.1, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.4 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const add = (parent: THREE.Object3D, m: THREE.Mesh, x = 0, y = 0, z = 0) => { m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  const root = new THREE.Group();
  // fuselage: a lathe profile along Z
  const prof: [number, number][] = [[0, -4.1], [0.42, -4.0], [0.62, -3.5], [0.68, -2.6], [0.66, -1.2], [0.55, 0.2], [0.38, 1.8], [0.2, 3.2], [0.08, 3.9]];
  const fus = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 20);
  fus.rotateX(Math.PI / 2); fus.scale(1, 1.15, 1);
  add(root, new THREE.Mesh(fus, paint));
  // cabin glazing and a stripe
  const cab = new THREE.Mesh(new THREE.SphereGeometry(0.66, 20, 10, 0, Math.PI * 2, 0.15 * Math.PI, 0.32 * Math.PI), glass);
  cab.scale.set(1.02, 1.1, 1.9); add(root, cab, 0, 0.12, -1.6);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.69, 0.6, 3.2, 20, 1, true), accent);
  stripe.rotation.x = Math.PI / 2; stripe.scale.set(1, 1, 0.12); add(root, stripe, 0, -0.18, -0.6);
  // high wing: tapered, slight dihedral
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0); wingShape.lineTo(5.5, 0.15); wingShape.lineTo(5.5, 1.3); wingShape.lineTo(0, 1.6); wingShape.lineTo(0, 0);
  for (const side of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(wingShape, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 1 });
    g.rotateX(Math.PI / 2); g.scale(side, 1, 1);
    const w = add(root, new THREE.Mesh(g, paint), 0, 0.82, -2.3);
    w.rotation.z = side * 0.03;
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 1.2), accent); add(root, tip, side * 5.5, 0.92, -1.6);
    // strut from fuselage to wing
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6), paint);
    strut.rotation.z = side * -1.25; add(root, strut, side * 1.25, 0.25, -1.8);
  }
  // tail: tapered stabiliser and swept fin
  const stab = new THREE.Shape(); stab.moveTo(-1.8, 0); stab.lineTo(1.8, 0); stab.lineTo(1.4, 0.9); stab.lineTo(-1.4, 0.9); stab.lineTo(-1.8, 0);
  const sg = new THREE.ExtrudeGeometry(stab, { depth: 0.08, bevelEnabled: false }); sg.rotateX(Math.PI / 2);
  add(root, new THREE.Mesh(sg, paint), 0, 0.12, 3.0);
  const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(1.3, 0); fin.lineTo(1.0, 1.5); fin.lineTo(0.45, 1.5); fin.lineTo(0, 0);
  const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.08, bevelEnabled: false }); fg.rotateY(-Math.PI / 2); fg.translate(0.04, 0, 0);
  add(root, new THREE.Mesh(fg, accent), 0, 0.2, 2.6);
  // landing gear with wheel spats
  for (const [x, z] of [[-1.15, -0.9], [1.15, -0.9], [0, -3.3]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9), dark);
    leg.rotation.z = x ? Math.sign(x) * -0.5 : 0; add(root, leg, x * 0.75, -0.95, z);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 14), tyre); wheel.rotation.z = Math.PI / 2; add(root, wheel, x, -1.35, z);
    const spat = ball(0.23, paint, 0.6, 0.8, 1.5); add(root, spat, x, -1.3, z);
  }
  // propeller: spinner, two blades, and a translucent disc at speed
  const prop = new THREE.Group(); prop.position.z = -4.15; root.add(prop);
  add(prop, new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 14).rotateX(-Math.PI / 2), paint), 0, 0, -0.15);
  const blades = new THREE.Group(); prop.add(blades);
  for (const a of [0, Math.PI]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.95, 0.04), dark);
    b.position.y = Math.cos(a) * 0.5; b.rotation.y = 0.35; blades.add(b);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.0, 32), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, depthWrite: false }));
  disc.position.z = -0.02; prop.add(disc);
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { root, prop, disc, blades };
}

/** Rotation that turns the downloaded aircraft's nose towards −Z (set after inspecting the model). */
export const PLANE_YAW_FIX = Math.PI;

/** Arcade flight: W/S throttle, mouse or arrows pitch, A/D roll; banking turns the plane. Inputs are smoothed. */
export class Plane {
  readonly root: THREE.Group;
  private parts: ReturnType<typeof makeAircraft>;
  speed = 45;
  private q = new THREE.Quaternion();
  private pitchRate = 0; private rollRate = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();

  private mixer: THREE.AnimationMixer | null = null;

  private ray = new THREE.Raycaster();
  /** Called when the plane hits something (the viewer shows a message). */
  onCrash: () => void = () => {};

  constructor(private cam: THREE.PerspectiveCamera, private obstacles: () => THREE.Object3D[] = () => []) {
    this.ray.firstHitOnly = true;
    this.parts = makeAircraft();
    this.root = new THREE.Group();
    this.root.add(this.parts.root);
    loadNormalised("/models/plane.glb", 9, "span").then(({ holder, inner, animations, dims }) => {
      // nose points along the model's long axis; make it −Z (forward) like ours
      inner.rotation.y += PLANE_YAW_FIX;
      this.root.remove(this.parts.root);
      this.root.add(holder);
      const idle = animations.find((a) => /idle|prop/i.test(a.name));
      if (idle) { this.mixer = new THREE.AnimationMixer(inner); this.mixer.clipAction(idle).play(); }
    }).catch(() => { /* keep the built-in aircraft */ });
  }

  placeAt(x: number, y: number, z: number, yaw: number) {
    this.root.position.set(x, y, z);
    this.q.setFromEuler(new THREE.Euler(0, -yaw, 0, "YXZ"));
    this.root.quaternion.copy(this.q);
    this.speed = 45; this.pitchRate = this.rollRate = 0;
    this.camPos.copy(this.root.position).add(new THREE.Vector3(0, 4, 16).applyQuaternion(this.q));
    this.camLook.copy(this.root.position);
  }

  update(dt: number, i: Input) {
    if (has(i, "KeyW", "ShiftLeft")) this.speed = Math.min(110, this.speed + 22 * dt);
    if (has(i, "KeyS", "ControlLeft")) this.speed = Math.max(20, this.speed - 22 * dt);
    // target rates from mouse and keys, then ease towards them (no twitchy snapping)
    let tp = -i.dy * 0.08, tr = -i.dx * 0.08;
    if (has(i, "ArrowUp")) tp -= 1.0;
    if (has(i, "ArrowDown")) tp += 1.0;
    if (has(i, "KeyA", "ArrowLeft")) tr += 1.6;
    if (has(i, "KeyD", "ArrowRight")) tr -= 1.6;
    tp = THREE.MathUtils.clamp(tp, -1.6, 1.6); tr = THREE.MathUtils.clamp(tr, -2.4, 2.4);
    this.pitchRate += (tp - this.pitchRate) * damp(6, dt);
    this.rollRate += (tr - this.rollRate) * damp(6, dt);
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitchRate * dt));
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.rollRate * dt));
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.q);
    const bank = Math.asin(THREE.MathUtils.clamp(-right.y, -1, 1));
    const turn = (9.8 * Math.tan(THREE.MathUtils.clamp(bank, -1.2, 1.2)) / Math.max(this.speed, 20)) * dt;
    this.q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), turn));
    if (Math.abs(tr) < 0.05) this.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), bank * 0.5 * dt));
    this.q.normalize();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.q);
    // collide with buildings: look ahead along the flight path (plus a little margin for the wings)
    this.ray.set(this.root.position, fwd); this.ray.far = this.speed * dt + 4;
    if (this.ray.intersectObjects(this.obstacles(), false).length) {
      // crash: respawn level, climbing away from the impact
      this.root.position.addScaledVector(fwd, -40).setY(this.root.position.y + 60);
      this.q.setFromEuler(new THREE.Euler(0, new THREE.Euler().setFromQuaternion(this.q, "YXZ").y, 0, "YXZ"));
      this.pitchRate = this.rollRate = 0; this.speed = 40;
      this.onCrash();
      return;
    }
    this.root.position.addScaledVector(fwd, this.speed * dt);
    if (this.speed < 30) this.root.position.y -= (30 - this.speed) * 0.4 * dt;
    if (this.root.position.y < 3) {
      this.root.position.y = 3;
      if (fwd.y < 0) this.q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 2 * dt));
    }
    this.root.position.y = Math.min(this.root.position.y, 6000);
    this.root.quaternion.copy(this.q);
    this.mixer?.update(dt * (0.5 + this.speed / 60));
    // propeller: blades when slow, a blurred disc when fast
    const p = this.parts;
    p.blades.rotation.z += this.speed * dt * 1.4;
    (p.disc.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp((this.speed - 25) / 80, 0, 0.35);
    p.blades.visible = this.speed < 70;
    // chase camera: behind/above with lag, looking slightly ahead; banks a little with the plane
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.q);
    const want = this.root.position.clone().add(new THREE.Vector3(0, 3.2, 15).applyQuaternion(this.q));
    want.y = Math.max(want.y, this.root.position.y + 1.5, 2);
    this.camPos.lerp(want, damp(5, dt));
    this.camLook.lerp(this.root.position.clone().addScaledVector(fwd, 25), damp(8, dt));
    this.cam.position.copy(this.camPos);
    this.cam.up.lerp(new THREE.Vector3(0, 1, 0).lerp(up, 0.35), damp(4, dt)).normalize();
    this.cam.lookAt(this.camLook);
  }

  get position() { return this.root.position; }
}
