// Fly / walk camera: drag to look, WASD to move, Q/E down/up, Shift for speed, wheel to dolly.
import * as THREE from "three";

export type Mode = "fly" | "walk";

export class Controls {
  yaw = 0;        // radians, 0 = looking north, positive = turning east (clockwise)
  pitch = -0.35;  // radians
  private tYaw: number | null = null;   // smoothed mouse-look targets
  private tPitch: number | null = null;
  private vel = new THREE.Vector3();
  private glide: { from: THREE.Vector3; to: THREE.Vector3; fy: number; ty: number; fp: number; tp: number; t: number } | null = null;
  mode: Mode = "fly";
  private keys = new Set<string>();
  private dragging = false;
  private last = { x: 0, y: 0 };
  private pinch = 0;
  onChange = () => {};

  constructor(private cam: THREE.PerspectiveCamera, private el: HTMLElement) {
    el.addEventListener("pointerdown", (e) => { this.dragging = true; this.last = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointerup", (e) => { this.dragging = false; el.releasePointerCapture(e.pointerId); });
    el.addEventListener("pointermove", (e) => {
      if (!this.dragging || (e.pointerType === "touch" && this.pinch)) return;
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      this.tYaw = (this.tYaw ?? this.yaw) + dx * 0.0035; this.tPitch = THREE.MathUtils.clamp((this.tPitch ?? this.pitch) - dy * 0.0035, -1.55, 1.4);
      this.onChange();
    });
    el.addEventListener("wheel", (e) => { e.preventDefault(); this.dolly(-e.deltaY * this.speed() * 0.004); }, { passive: false });
    el.addEventListener("touchstart", (e) => { if (e.touches.length === 2) this.pinch = this.touchDist(e); }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 2 || !this.pinch) return;
      const d = this.touchDist(e); this.dolly((d - this.pinch) * this.speed() * 0.02); this.pinch = d;
    }, { passive: true });
    el.addEventListener("touchend", () => { this.pinch = 0; });
    window.addEventListener("keydown", (e) => { if ((e.target as HTMLElement)?.closest?.("input,textarea")) return; this.keys.add(e.code); });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private touchDist(e: TouchEvent) { const [a, b] = [e.touches[0], e.touches[1]]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }

  /** Mouse-look from pointer-lock deltas. */
  look(dx: number, dy: number) {
    if (!dx && !dy) return;
    this.tYaw = (this.tYaw ?? this.yaw) + dx * 0.0022; this.tPitch = THREE.MathUtils.clamp((this.tPitch ?? this.pitch) - dy * 0.0022, -1.55, 1.4);
    this.onChange();
  }

  setMode(m: Mode) {
    this.mode = m;
    if (m === "walk") { this.cam.position.y = 1.7; this.pitch = 0; }
    else if (this.cam.position.y < 30) { this.cam.position.y = 60; this.pitch = -0.4; }
    this.onChange();
  }

  speed(): number {
    const fast = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    if (this.mode === "walk") return fast ? 12 : 4;
    return Math.max(15, this.cam.position.y * 0.9) * (fast ? 4 : 1);
  }

  forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  private dolly(d: number) {
    const f = this.forward();
    if (this.mode === "walk") { f.y = 0; f.normalize(); }
    this.cam.position.addScaledVector(f, d);
    this.clamp(); this.onChange();
  }

  private clamp() {
    if (this.mode === "walk") this.cam.position.y = 1.7;
    else this.cam.position.y = THREE.MathUtils.clamp(this.cam.position.y, 2, 8000);
  }

  /** Smoothly fly the camera to look at a point from a heading/pitch/distance. */
  glideTo(target: THREE.Vector3, headingDeg: number, pitchDeg: number, dist: number) {
    const yaw = THREE.MathUtils.degToRad(headingDeg), pitch = THREE.MathUtils.degToRad(pitchDeg);
    const f = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    this.glide = { from: this.cam.position.clone(), to: target.clone().addScaledVector(f, -dist), fy: this.yaw, ty: yaw, fp: this.pitch, tp: pitch, t: 0 };
    this.tYaw = this.tPitch = null;
  }

  update(dt: number) {
    if (this.glide) {
      const g = this.glide;
      g.t = Math.min(1, g.t + dt / 1.6);
      const e = g.t < 0.5 ? 4 * g.t ** 3 : 1 - (-2 * g.t + 2) ** 3 / 2;
      this.cam.position.lerpVectors(g.from, g.to, e);
      // arc up a little on the way
      this.cam.position.y += Math.sin(Math.PI * g.t) * g.from.distanceTo(g.to) * 0.15;
      const dy = Math.atan2(Math.sin(g.ty - g.fy), Math.cos(g.ty - g.fy));
      this.yaw = g.fy + dy * e; this.pitch = g.fp + (g.tp - g.fp) * e;
      if (g.t >= 1) this.glide = null;
      this.cam.lookAt(this.cam.position.clone().add(this.forward()));
      this.onChange();
      return;
    }
    // ease mouse-look towards its target
    const kLook = 1 - Math.exp(-22 * dt);
    if (this.tYaw != null) { this.yaw += (this.tYaw - this.yaw) * kLook; if (Math.abs(this.tYaw - this.yaw) < 1e-4) this.tYaw = null; }
    if (this.tPitch != null) { this.pitch += (this.tPitch - this.pitch) * kLook; if (Math.abs(this.tPitch - this.pitch) < 1e-4) this.tPitch = null; }
    const k = this.keys;
    const f = this.forward(), flat = new THREE.Vector3(f.x, 0, f.z).normalize();
    const right = new THREE.Vector3(-flat.z, 0, flat.x);
    const mv = new THREE.Vector3();
    if (k.has("KeyW") || k.has("ArrowUp")) mv.add(this.mode === "fly" ? flat : flat);
    if (k.has("KeyS") || k.has("ArrowDown")) mv.sub(flat);
    if (k.has("KeyD") || k.has("ArrowRight")) mv.add(right);
    if (k.has("KeyA") || k.has("ArrowLeft")) mv.sub(right);
    if (this.mode === "fly") {
      if (k.has("KeyE") || k.has("Space")) mv.y += 1;
      if (k.has("KeyQ") || k.has("KeyC")) mv.y -= 1;
    }
    // accelerate and glide to a stop instead of moving in jerky steps
    const want = mv.lengthSq() > 0 ? mv.normalize().multiplyScalar(this.speed()) : mv;
    this.vel.lerp(want, 1 - Math.exp(-(want.lengthSq() ? 6 : 4) * dt));
    if (this.vel.lengthSq() > 1e-4) {
      this.cam.position.addScaledVector(this.vel, dt);
      this.clamp(); this.onChange();
    }
    const target = this.cam.position.clone().add(this.forward());
    this.cam.lookAt(target);
  }

  /** Point the camera at a world position from a given heading/pitch/distance. */
  orbitTo(target: THREE.Vector3, headingDeg: number, pitchDeg: number, dist: number) {
    this.yaw = (headingDeg * Math.PI) / 180;
    this.pitch = (pitchDeg * Math.PI) / 180;
    const f = this.forward();
    this.cam.position.copy(target).addScaledVector(f, -dist);
    if (this.mode === "walk") this.cam.position.y = 1.7;
    this.cam.lookAt(target);
    this.onChange();
  }
}
