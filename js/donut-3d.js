// The Insights "Ring": the month's categories as a tilted 3D ring of solid slices that can be
// spun, flung and tapped; the slice at the front is raised and the caption names it.
// Loaded with import() only when the Ring view is first shown, so three.js (js/three.module.min.js,
// MIT, see js/three.LICENSE.txt) is never parsed otherwise. The maths lives in js/donut-math.js.
//
// One renderer, canvas, set of materials and shadow shader serve the whole session: a new month
// only rebuilds the slice geometry, so no shader is compiled twice. Frames are drawn only while
// something moves (a drag, fling or snap), on resize and on a theme change.

import * as THREE from './three.module.min.js';
import {
  RING, TAU, sliceAngles, sliceWeights, sliceColour, frontIndex, targetFor, stepMotion,
  releaseVelocity, release, isTap, MOTION,
} from './donut-math.js';

const RO = 2.0, RI = 1.22, DEPTH = 0.34, GAP = 0.05, BEVEL = 0.035;
const LIFT_UP = RING.lift * DEPTH;   // world units at full weight
const LIFT_OUT = 0.04 * RO;          // outward push at full weight
const ELEV = (34 * Math.PI) / 180;   // camera elevation: the ring tilted toward the viewer
const MAX_SLICES = 40;               // the shadow shader's array size
const MAX_DPR = 2;

/** For tests and the developer: frames drawn, the last frame's CPU time, draw calls and triangles. */
export const ringStats = { frames: 0, lastMs: 0, calls: 0, triangles: 0, running: false };

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const cssVarName = (value) => /var\((--[\w-]+)\)/.exec(value)?.[1] ?? null;

let shared = null;   // { renderer, canvas, scene, camera, hemi, sun, ring, ground, groundU, materials }
let lost = false;    // the WebGL context was lost: the app shows the flat donut from then on
let current = null;  // the ring now attached to the canvas

/** True if a WebGL context can be made here (and has not been lost this session). */
export function ringAvailable() {
  if (lost) return false;
  if (shared) return true;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function setup() {
  const canvas = document.createElement('canvas');
  canvas.className = 'ring-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.6);
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-3, 6, 4);
  scene.add(hemi, sun);
  const ring = new THREE.Group();
  scene.add(ring);

  // A soft ring shadow worked out per fragment on one quad: each slice's shadow follows its lift,
  // moving a little toward the viewer and softening, so the gap under a raised slice shows.
  const groundU = {
    uRot: { value: 0 }, uInk: { value: 0.3 }, uCount: { value: 0 },
    uLift: { value: new Float32Array(MAX_SLICES) },
    uRange: { value: Array.from({ length: MAX_SLICES }, () => new THREE.Vector2()) },
    uBase: { value: new THREE.Vector2(0.12, -0.03) },
    uLight: { value: new THREE.Vector2(0.25, 0.55) },
  };
  const f = (n) => n.toFixed(4);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(RO * 3, RO * 3), new THREE.ShaderMaterial({
    uniforms: groundU, transparent: true, depthWrite: false,
    vertexShader: `varying vec2 vP;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `#define N ${MAX_SLICES}
      uniform float uRot, uInk; uniform int uCount; uniform float uLift[N]; uniform vec2 uRange[N]; uniform vec2 uBase, uLight;
      varying vec2 vP;
      const float RI = ${f(RI)}, RO = ${f(RO)}, LUP = ${f(LIFT_UP)}, LOUT = ${f(LIFT_OUT)};
      float wrapPi(float x) { return mod(x + 3.14159265, 6.28318531) - 3.14159265; }
      float sliceShadow(float r, float th, vec2 rg, float soft) {
        float band = smoothstep(RI - soft, RI + soft, r) * (1.0 - smoothstep(RO - soft, RO + soft, r));
        float d = abs(wrapPi(th - rg.x));
        float e = soft / max(r, 0.5);
        return band * (1.0 - smoothstep(rg.y - e, rg.y + e, d));
      }
      void main() {
        vec2 qb = vP - uBase;
        float rb = length(qb), tb = atan(qb.x, qb.y) - uRot;
        float a = 0.0;
        for (int i = 0; i < N; i++) {
          if (i >= uCount) break;
          float l = uLift[i];
          if (l < 0.002) { a = max(a, sliceShadow(rb, tb, uRange[i], 0.16)); continue; }
          float m = uRange[i].x + uRot;
          vec2 q = qb - l * (LUP * uLight + LOUT * vec2(sin(m), cos(m)));
          a = max(a, sliceShadow(length(q), atan(q.x, q.y) - uRot, uRange[i], 0.16 + 0.14 * l) * (1.0 - 0.12 * l));
        }
        gl_FragColor = vec4(0.0, 0.0, 0.0, a * uInk);
      }`,
  }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.005;
  scene.add(ground);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
    const ring = current;
    teardown();
    ring?.fail('context lost');
  });

  shared = { renderer, canvas, scene, camera, hemi, sun, ring, ground, groundU, materials: [] };
}

function teardown() {
  if (!shared) return;
  current?.detach();
  const { renderer, ground, materials } = shared;
  materials.forEach((m) => m.dispose());
  ground.geometry.dispose();
  ground.material.dispose();
  renderer.dispose();
  shared.canvas.remove();
  shared = null;
}

function sliceGeometry(g) {
  const shape = new THREE.Shape();
  const n = Math.max(3, Math.ceil(g.span / (TAU / 96)));
  const arc = (rad, from, to) => {
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const a = from + ((to - from) * k) / n;
      pts.push([rad * Math.sin(a), -rad * Math.cos(a)]);
    }
    return pts;
  };
  // A lone slice is a full ring: leave a hairline gap so the shape stays a simple outline.
  const oPad = GAP / 2 / RO, iPad = GAP / 2 / RI;
  [...arc(RO, g.a0 + oPad, g.a1 - oPad), ...arc(RI, g.a1 - iPad, g.a0 + iPad)]
    .forEach(([x, y], k) => (k ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: DEPTH - 2 * BEVEL, curveSegments: 1, steps: 1,
    bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelOffset: -BEVEL, bevelSegments: 2,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, BEVEL, 0);
  return geo;
}

/**
 * Attach a ring for `slices` ([{ key, name, total, swatch }], swatch a CSS value such as
 * 'var(--group-3)') to `stage`, with slice `selected` at the front. Callbacks:
 * onFront(i) whenever the front slice changes, onSettle(i) when the ring comes to rest,
 * onFail(reason) if the 3D view stops working (the caller shows the flat donut).
 * Returns { goTo(i), front(), theme(), detach() }. Throws if WebGL isn't available.
 */
export function createRing(stage, { slices, selected = 0, onFront = () => {}, onSettle = () => {}, onFail = () => {} }) {
  if (lost) throw new Error('WebGL context lost');
  if (!shared) setup();
  current?.detach();
  const S = shared;
  const angles = sliceAngles(slices.map((s) => s.total));
  const n = slices.length;
  const m = { r: -angles[Math.min(selected, n - 1)].mid, v: 0, target: 0, phase: 'idle' };
  let front = frontIndex(angles, m.r);

  while (S.materials.length < n) S.materials.push(new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0 }));
  const meshes = angles.map((g, i) => {
    const mesh = new THREE.Mesh(sliceGeometry(g), S.materials[i]);
    mesh.userData = { i, dir: new THREE.Vector3(Math.sin(g.mid), 0, Math.cos(g.mid)) };
    S.ring.add(mesh);
    return mesh;
  });
  S.groundU.uCount.value = n;
  angles.forEach((g, i) => S.groundU.uRange.value[i].set(g.mid, g.span / 2 - GAP / 2 / RO));

  // Theme colours, in linear RGB as three.js works.
  const tmp = new THREE.Color();
  const lin = (value) => (tmp.setStyle(value || '#888888'), [tmp.r, tmp.g, tmp.b]);
  let base = [], surface = [1, 1, 1], glow = 0.08;
  function readTheme() {
    base = slices.map((s) => lin(css(cssVarName(s.swatch)) || s.swatch));
    surface = lin(css('--surface'));
    glow = parseFloat(css('--ring-glow')) || 0.08;
    S.hemi.color.setStyle(css('--ring-sky') || '#ffffff');
    S.hemi.groundColor.setStyle(css('--ring-ground') || '#888888');
    S.groundU.uInk.value = parseFloat(css('--ring-shadow')) || 0.3;
  }

  // Framing: fit the ring into the stage above the caption strip, then extend the view down over it.
  let pxPerRad = 200;
  const caption = stage.querySelector('.ring-caption');
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return false;
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    S.renderer.setSize(w, h, false);
    const cap = Math.min(h * 0.4, (caption?.offsetHeight || 70) + h * 0.06);
    const hFit = h - cap;
    const cam = S.camera;
    cam.aspect = w / hFit;
    cam.setViewOffset(w, hFit, 0, 0, w, h);
    const vHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const hHalf = vHalf * cam.aspect;
    const needW = RO + LIFT_OUT + 0.25;
    const needH = (RO + LIFT_OUT) * Math.sin(ELEV) + LIFT_UP * Math.cos(ELEV) + 0.5;
    const dist = Math.max(needW / hHalf, needH / vHalf) + RO * Math.cos(ELEV) * 0.5;
    cam.position.set(0, Math.sin(ELEV) * dist, Math.cos(ELEV) * dist);
    cam.lookAt(0, 0.05, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    pxPerRad = (RO / (hHalf * dist)) * w * 0.5 * 1.15;
    // Where the hole is on screen, for the month total that sits in it (app.css .ring-total): the
    // middle of the ground seen through it, from the far wall's foot to the raised front rim, and
    // the hole's width across its middle. Written as custom properties on the stage.
    const at = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(cam);
      return { x: ((v.x + 1) * w) / 2, y: ((1 - v.y) * h) / 2 };
    };
    const far = at(0, 0, -RI).y;
    const near = at(0, DEPTH + LIFT_UP, RI + LIFT_OUT).y;
    const px = (v) => `${v.toFixed(1)}px`;
    stage.style.setProperty('--ring-cx', px(w / 2));
    stage.style.setProperty('--ring-cy', px((far + near) / 2));
    stage.style.setProperty('--ring-hole-w', px(at(RI, DEPTH, 0).x - at(-RI, DEPTH, 0).x));
    stage.style.setProperty('--ring-hole-h', px(Math.max(0, near - far)));
    return true;
  }

  function draw() {
    const w = sliceWeights(angles, m.r);
    S.ring.rotation.y = m.r;
    S.groundU.uRot.value = m.r;
    meshes.forEach((mesh, i) => {
      const u = mesh.userData;
      mesh.position.copy(u.dir).multiplyScalar(LIFT_OUT * w[i]);
      mesh.position.y = LIFT_UP * w[i];
      const c = sliceColour(base[i], surface, w[i], glow);
      mesh.material.color.setRGB(c.colour[0], c.colour[1], c.colour[2]);
      mesh.material.emissive.setRGB(c.emissive[0], c.emissive[1], c.emissive[2]);
      S.groundU.uLift.value[i] = w[i];
    });
    S.renderer.info.reset();
    S.renderer.render(S.scene, S.camera);
    ringStats.frames++;
    ringStats.calls = S.renderer.info.render.calls;
    ringStats.triangles = S.renderer.info.render.triangles;
  }

  // Render on demand: one frame is requested at a time, and another only while the ring moves.
  let raf = 0, lastT = 0, attached = true;
  function frame(t) {
    raf = 0;
    if (!attached) return;
    const t0 = performance.now();
    const dt = lastT ? (t - lastT) / 1000 : 1 / 60;
    lastT = t;
    const settled = stepMotion(m, angles, dt);
    const f = frontIndex(angles, m.r);
    if (f !== front) { front = f; onFront(f); }
    draw();
    ringStats.lastMs = performance.now() - t0;
    if (settled) onSettle(front);
    if (m.phase !== 'idle') raf = requestAnimationFrame(frame);
    else { lastT = 0; ringStats.running = false; }
  }
  function kick() {
    if (!attached || raf) return;
    ringStats.running = true;
    raf = requestAnimationFrame(frame);
  }

  // Drag, fling and tap (pointer events, so mouse, touch and pen alike).
  const canvas = S.canvas;
  let pid = null, lastX = 0, downX = 0, downY = 0, downT = 0, samples = [];
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const b = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(ndc, S.camera);
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.i : -1;
  }
  const onDown = (e) => {
    if (pid !== null) return;
    pid = e.pointerId;
    try { canvas.setPointerCapture(pid); } catch { /* not an active pointer (synthetic events) */ }
    lastX = downX = e.clientX; downY = e.clientY; downT = performance.now();
    samples = [{ t: downT, r: m.r }];
    m.phase = 'drag'; m.v = 0;
    stage.classList.add('is-dragging');
    kick();
  };
  const onMove = (e) => {
    if (e.pointerId !== pid) return;
    m.r += (e.clientX - lastX) / pxPerRad;
    lastX = e.clientX;
    const t = performance.now();
    samples.push({ t, r: m.r });
    while (samples.length > 2 && t - samples[0].t > MOTION.sampleMs) samples.shift();
    kick();
  };
  const onUp = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    stage.classList.remove('is-dragging');
    const now = performance.now();
    if (isTap(e.clientX - downX, e.clientY - downY, now - downT)) {
      const i = pick(e);
      if (i >= 0) { api.goTo(i); return; }
    }
    release(m, angles, releaseVelocity(samples, now));
    kick();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  const ro = new ResizeObserver(() => { if (attached && resize()) draw(); });

  const api = {
    /** Bring slice i to the front with the snap spring. */
    goTo(i) {
      if (i < 0 || i >= n) return;
      m.target = targetFor(angles, i, m.r);
      m.phase = 'snap';
      if (i !== front) { front = i; onFront(i); }
      kick();
    },
    front: () => front,
    theme() { readTheme(); if (attached) draw(); },
    detach() {
      if (!attached) return;
      attached = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ringStats.running = false;
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      meshes.forEach((mesh) => { S.ring.remove(mesh); mesh.geometry.dispose(); });
      stage.classList.remove('is-dragging', 'has-ring');
      if (canvas.parentNode === stage) canvas.remove();
      if (current === api) current = null;
    },
    fail(reason) { api.detach(); onFail(reason); },
  };

  stage.prepend(canvas);
  stage.classList.add('has-ring');
  current = api;
  readTheme();
  if (resize()) draw();
  ro.observe(stage);
  return api;
}

/** Simulate a lost WebGL context (tests only). */
export function loseContextForTest() {
  shared?.renderer.getContext().getExtension('WEBGL_lose_context')?.loseContext();
}
