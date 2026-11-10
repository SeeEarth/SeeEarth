// Model workshop page: the CLI loads this headless, runs an agent's model script with the kit,
// exports the result as .glb and renders preview images from four sides.
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { kit, optimize } from "./kit";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd9e2ea);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x8a7f6a, 1.3));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.position.set(-40, 80, -60); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: 0xa9a49a, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

function stats(obj: THREE.Object3D) {
  let triangles = 0;
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  return { triangles: Math.round(triangles), size: [size.x, size.y, size.z].map((v) => Math.round(v * 10) / 10), min: [box.min.x, box.min.y, box.min.z].map((v) => Math.round(v * 10) / 10) };
}

/** Render the model from 4 sides (front/right/back/left, from slightly above) into one 2×2 image. */
function previews(obj: THREE.Object3D, sizePx = 512): string {
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z) * 0.5;
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  const out = document.createElement("canvas");
  out.width = out.height = sizePx * 2;
  const g = out.getContext("2d")!;
  renderer.setSize(sizePx, sizePx, false);
  const views: [string, number][] = [["front (-Z)", 180], ["right (+X)", 90], ["back (+Z)", 0], ["left (-X)", -90]];
  views.forEach(([label, deg], i) => {
    const a = THREE.MathUtils.degToRad(deg), dist = r / Math.tan(THREE.MathUtils.degToRad(20)) * 1.15;
    cam.position.set(c.x + Math.sin(a) * dist, c.y + dist * 0.35, c.z + Math.cos(a) * dist);
    cam.lookAt(c);
    renderer.render(scene, cam);
    g.drawImage(renderer.domElement, (i % 2) * sizePx, Math.floor(i / 2) * sizePx);
    g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect((i % 2) * sizePx, Math.floor(i / 2) * sizePx, 150, 26);
    g.fillStyle = "#fff"; g.font = "16px sans-serif"; g.fillText(label, (i % 2) * sizePx + 8, Math.floor(i / 2) * sizePx + 19);
  });
  return out.toDataURL("image/png").split(",")[1];
}

async function toGlbBase64(obj: THREE.Object3D): Promise<string> {
  const glb = await new Promise<ArrayBuffer>((res, rej) => new GLTFExporter().parse(obj, (r) => res(r as ArrayBuffer), rej, { binary: true, maxTextureSize: 512 }));
  const bytes = new Uint8Array(glb);
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Called by the CLI with the agent's compiled script (an IIFE assigning globalThis.__model). */
async function buildModel(code: string, opts: { params?: Record<string, unknown> } = {}) {
  const mod = new Function(`${code}\nreturn typeof __model === "undefined" ? undefined : __model;`)();
  const fn = mod?.default ?? mod?.build ?? mod;
  if (typeof fn !== "function") throw new Error("the model script must `export default function (k, THREE, params) { … return object }`");
  const raw: THREE.Object3D = await fn(kit, THREE, opts.params ?? {});
  if (!raw?.isObject3D) throw new Error("the model function must return a three.js Object3D (e.g. k.group(...))");
  const obj = optimize(raw);
  scene.add(obj);
  const st = stats(obj);
  // show the real footprint in red in the previews (not exported), so mismatches are obvious
  const fp = (opts.params as { footprint?: [number, number][] } | undefined)?.footprint;
  let outline: THREE.Line | null = null;
  if (fp?.length) {
    outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([...fp, fp[0]].map(([x, z]) => new THREE.Vector3(x, 0.15, z))), new THREE.LineBasicMaterial({ color: 0xe0302a }));
    scene.add(outline);
  }
  const preview = previews(obj);
  if (outline) scene.remove(outline);
  const glb = await toGlbBase64(obj);
  scene.remove(obj);
  return { ...st, preview, glb };
}

Object.assign(window, { SE: { THREE, kit, buildModel }, __SE_READY__: true });
