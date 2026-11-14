// Three.js scene: the stone (height-field face + extruded body), the V-bit and
// spindle, and toolpath overlays.
import * as THREE from 'three';
import { OrbitControls } from './../vendor/OrbitControls.js';

export const STONES = {
  black: { label: 'Absolute black granite', base: [0.03, 0.03, 0.034], s1: [0.012, 0.012, 0.014], s2: [0.16, 0.16, 0.18], frost: [0.66, 0.66, 0.64], side: 0x3a3a3e, polish: 1.0, veins: 0 },
  grey: { label: 'Barre grey granite', base: [0.46, 0.46, 0.47], s1: [0.12, 0.12, 0.13], s2: [0.85, 0.85, 0.85], frost: [0.80, 0.80, 0.79], side: 0x8d8d90, polish: 0.8, veins: 0 },
  red: { label: 'India red granite', base: [0.46, 0.17, 0.14], s1: [0.08, 0.06, 0.06], s2: [0.75, 0.55, 0.5], frost: [0.80, 0.62, 0.57], side: 0x8a4a40, polish: 0.85, veins: 0 },
  blue: { label: 'Blue pearl granite', base: [0.13, 0.15, 0.2], s1: [0.03, 0.03, 0.05], s2: [0.45, 0.55, 0.75], frost: [0.65, 0.68, 0.72], side: 0x3d4452, polish: 1.0, veins: 0 },
  marble: { label: 'White marble', base: [0.88, 0.88, 0.86], s1: [0.62, 0.63, 0.65], s2: [0.95, 0.95, 0.94], frost: [0.80, 0.80, 0.78], side: 0xd9d9d4, polish: 0.6, veins: 1 },
  sandstone: { label: 'Sandstone', base: [0.76, 0.64, 0.47], s1: [0.6, 0.48, 0.33], s2: [0.86, 0.77, 0.62], frost: [0.70, 0.58, 0.42], side: 0xb79d75, polish: 0.0, veins: 0 },
};

export const FILLS = {
  none: { label: 'None (frosted)', color: [0, 0, 0], metal: 0 },
  white: { label: 'White paint', color: [0.92, 0.92, 0.9], metal: 0 },
  gold: { label: 'Gold leaf', color: [0.95, 0.72, 0.3], metal: 1 },
  silver: { label: 'Silver leaf', color: [0.85, 0.86, 0.88], metal: 1 },
  black: { label: 'Black paint', color: [0.03, 0.03, 0.03], metal: 0 },
  custom: { label: 'Custom colour', color: null, metal: 0 },
};

const vert = /* glsl */`
uniform sampler2D uHeight;
uniform vec2 uGridSize;
varying vec2 vUv;
varying vec3 vViewPos;
varying vec3 vNx, vNy, vNz;
void main() {
  vNx = normalMatrix * vec3(1.0, 0.0, 0.0);
  vNy = normalMatrix * vec3(0.0, 1.0, 0.0);
  vNz = normalMatrix * vec3(0.0, 0.0, 1.0);
  vec2 uvT = (uv * (uGridSize - 1.0) + 0.5) / uGridSize;
  vUv = uvT;
  float h = texture2D(uHeight, uvT).r;
  vec3 p = position;
  p.z += h;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */`
uniform sampler2D uHeight;
uniform sampler2D uMask;
uniform sampler2D uDesign;
uniform vec2 uGridSize;
uniform float uCell;
uniform vec3 uBase, uS1, uS2, uFrost, uFill;
uniform float uPolish, uVeins, uFillOn, uFillMetal, uLayout, uFillDepth;
uniform vec3 uL1, uL2; // light directions (view space)
varying vec2 vUv;
varying vec3 vViewPos;
varying vec3 vNx, vNy, vNz;

float sampleH(vec2 uv) {
  vec2 p = uv * uGridSize - 0.5;
  vec2 f = fract(p);
  vec2 t = 1.0 / uGridSize;
  vec2 b = (floor(p) + 0.5) * t;
  float a = texture2D(uHeight, b).r;
  float c = texture2D(uHeight, b + vec2(t.x, 0.0)).r;
  float d = texture2D(uHeight, b + vec2(0.0, t.y)).r;
  float e = texture2D(uHeight, b + t).r;
  return mix(mix(a, c, f.x), mix(d, e, f.x), f.y);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  if (texture2D(uMask, vUv).r < 0.5) discard;
  vec2 t = 1.0 / uGridSize;
  float hc = sampleH(vUv);
  float hl = sampleH(vUv - vec2(t.x, 0.0));
  float hr = sampleH(vUv + vec2(t.x, 0.0));
  float hd = sampleH(vUv - vec2(0.0, t.y));
  float hu = sampleH(vUv + vec2(0.0, t.y));
  vec3 nObj = normalize(vec3(-(hr - hl) / (2.0 * uCell), -(hu - hd) / (2.0 * uCell), 1.0));
  vec3 N = normalize(nObj.x * vNx + nObj.y * vNy + nObj.z * vNz);
  vec3 V = normalize(-vViewPos);

  vec2 mm = vUv * uGridSize * uCell;
  float depth = -hc;

  // --- stone albedo ---
  // fade fine crystal speckle out when a pixel covers more than ~1 mm,
  // otherwise it shimmers at a distance
  float fw = max(fwidth(mm.x), fwidth(mm.y));
  float detail = 1.0 - smoothstep(0.6, 2.2, fw);
  float g1 = noise(mm * 0.9);
  float g2 = noise(mm * 2.3 + 17.0);
  float coarse = fbm(mm * 0.05);
  vec3 stone = uBase * (0.9 + 0.2 * coarse);
  stone = mix(stone, uS1, mix(0.3, smoothstep(0.62, 0.8, g1), detail) * 0.8);
  stone = mix(stone, uS2, mix(0.08, smoothstep(0.8, 0.9, g2), detail) * 0.7);
  if (uVeins > 0.5) {
    float vv = abs(sin(mm.x * 0.012 + mm.y * 0.02 + fbm(mm * 0.012) * 9.0));
    stone = mix(uS1, stone, smoothstep(0.0, 0.12, vv));
  }

  float carved = smoothstep(0.015, 0.12, depth);
  vec3 frost = uFrost * (0.9 + 0.2 * mix(0.5, g2, detail));
  vec3 albedo = mix(stone, frost, carved);
  float specStr = mix(0.55 * uPolish, 0.03, carved);
  float shin = mix(90.0, 6.0, carved);
  float metal = 0.0;

  if (uFillOn > 0.5) {
    float filled = smoothstep(uFillDepth, uFillDepth + 0.1, depth);
    albedo = mix(albedo, uFill, filled);
    specStr = mix(specStr, uFillMetal > 0.5 ? 0.9 : 0.15, filled);
    shin = mix(shin, uFillMetal > 0.5 ? 40.0 : 20.0, filled);
    metal = uFillMetal * filled;
  }

  // layout preview: tint uncarved design cells
  if (uLayout > 0.5) {
    float d = texture2D(uDesign, vUv).r;
    albedo = mix(albedo, vec3(0.9, 0.25, 0.15), d * (1.0 - carved) * 0.45);
  }

  // --- lighting ---
  vec3 col = albedo * 0.22; // ambient
  vec3 Ls[2]; Ls[0] = uL1; Ls[1] = uL2;
  float Li[2]; Li[0] = 1.0; Li[1] = 0.45;
  for (int i = 0; i < 2; i++) {
    vec3 L = normalize(Ls[i]);
    float diff = max(dot(N, L), 0.0);
    vec3 Hh = normalize(L + V);
    float sp = pow(max(dot(N, Hh), 0.0), shin) * specStr;
    vec3 spc = mix(vec3(1.0), albedo, metal);
    col += Li[i] * (albedo * diff * (1.0 - metal * 0.6) + spc * sp);
  }
  // cavity darkening on the steep walls of the V
  float slope = 1.0 - nObj.z;
  col *= 1.0 - clamp(slope * 0.35 + depth * 0.015, 0.0, 0.35);

  // polished stone reflects the sky
  vec3 R = reflect(-V, N);
  vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float sky = dot(R, upView) * 0.5 + 0.5;
  vec3 env = mix(vec3(0.08, 0.08, 0.09), vec3(0.75, 0.8, 0.88), smoothstep(0.35, 0.9, sky));
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  float envAmt = mix(uPolish * (0.03 + fres * 0.35), 0.0, carved);
  envAmt = max(envAmt, metal * 0.35);
  col += env * envAmt * mix(vec3(1.0), albedo, metal);

  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

/** Drop the triangles of an extrusion that lie in the z = 0 plane. */
function stripFrontCap(geo) {
  const pos = geo.getAttribute('position');
  const keep = [];
  for (let t = 0; t < pos.count; t += 3) {
    if (pos.getZ(t) > -1e-3 && pos.getZ(t + 1) > -1e-3 && pos.getZ(t + 2) > -1e-3) continue;
    keep.push(t, t + 1, t + 2);
  }
  geo.setIndex(keep);
  geo.clearGroups();
}

export class Viewer {
  constructor(container) {
    this.container = container;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1d2026);
    this.camera = new THREE.PerspectiveCamera(40, 1, 5, 20000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x30302a, 0.9));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(-600, 1200, 900);
    this.scene.add(this.sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(800, 500, -400);
    this.scene.add(fill);

    // machine space: local x = across face, y = up the face, z = up from face
    this.machine = new THREE.Group();
    this.machine.rotation.x = -Math.PI / 2;
    this.scene.add(this.machine);

    this.tool = this.makeTool({ angle: 90, diameter: 12.7 });
    this.machine.add(this.tool);

    this.pathGroup = new THREE.Group();
    this.machine.add(this.pathGroup);

    this.light1 = new THREE.Vector3(-0.45, 0.8, 0.55);
    this.light2 = new THREE.Vector3(0.7, 0.4, -0.3);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(container);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Build (or rebuild) the stone for a new grid / outline. */
  buildStone(grid, outlinePts, outlineMask, designMask, thickness, height) {
    this.disposeStone();
    const { W, H, cell } = grid;
    this.grid = grid;

    this.heightTex = new THREE.DataTexture(height, W, H, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.needsUpdate = true;

    this.maskTex = new THREE.DataTexture(outlineMask, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTex.minFilter = this.maskTex.magFilter = THREE.LinearFilter;
    this.maskTex.needsUpdate = true;

    const design8 = new Uint8Array(designMask.length);
    for (let k = 0; k < design8.length; k++) design8[k] = designMask[k] ? 255 : 0;
    this.designTex = new THREE.DataTexture(design8, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    this.designTex.minFilter = this.designTex.magFilter = THREE.LinearFilter;
    this.designTex.needsUpdate = true;

    // mesh resolution is capped; fine detail comes from per-pixel normals
    const segX = Math.min(W - 1, 900), segY = Math.min(H - 1, 900);
    const geo = new THREE.PlaneGeometry((W - 1) * cell, (H - 1) * cell, segX, segY);
    geo.deleteAttribute('normal');
    this.faceMat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uHeight: { value: this.heightTex },
        uMask: { value: this.maskTex },
        uDesign: { value: this.designTex },
        uGridSize: { value: new THREE.Vector2(W, H) },
        uCell: { value: cell },
        uBase: { value: new THREE.Vector3() }, uS1: { value: new THREE.Vector3() }, uS2: { value: new THREE.Vector3() },
        uFrost: { value: new THREE.Vector3() }, uFill: { value: new THREE.Vector3() },
        uPolish: { value: 1 }, uVeins: { value: 0 }, uFillOn: { value: 0 }, uFillMetal: { value: 0 },
        uLayout: { value: 1 }, uFillDepth: { value: 0.25 },
        uL1: { value: new THREE.Vector3() }, uL2: { value: new THREE.Vector3() },
      },
    });
    this.face = new THREE.Mesh(geo, this.faceMat);
    this.face.position.set((W * cell) / 2, (H * cell) / 2, 0);
    this.machine.add(this.face);

    // body of the stone
    const shape = new THREE.Shape(outlinePts.map(([x, y]) => new THREE.Vector2(x, y)));
    const body = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
    body.translate(0, 0, -thickness);
    stripFrontCap(body); // the carved face mesh replaces the front cap
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.92, metalness: 0, });
    this.body = new THREE.Mesh(body, this.bodyMat);
    this.machine.add(this.body);

    // machine bed + spoilboard
    const bw = grid.widthMM + 400, bh = grid.heightMM + 400;
    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(bw, bh, 30),
      new THREE.MeshStandardMaterial({ color: 0x6b5a45, roughness: 0.95 }),
    );
    bed.position.set(grid.widthMM / 2, grid.heightMM / 2, -thickness - 15);
    this.machine.add(bed);
    const grid3 = new THREE.GridHelper(Math.max(bw, bh), Math.round(Math.max(bw, bh) / 50), 0x8a7860, 0x7a6850);
    grid3.rotation.x = Math.PI / 2;
    grid3.position.set(grid.widthMM / 2, grid.heightMM / 2, -thickness + 0.2);
    this.machine.add(grid3);
    this.bed = [bed, grid3];

    // origin marker
    const axes = new THREE.AxesHelper(40);
    axes.position.set(0, 0, 0.5);
    this.machine.add(axes);
    this.bed.push(axes);

    this.machine.position.set(-grid.widthMM / 2, 0, grid.heightMM / 2);
    this.thickness = thickness;
    this.frame();
  }

  frame() {
    if (!this.grid) return;
    const s = Math.max(this.grid.widthMM, this.grid.heightMM);
    this.camera.position.set(0, s * 1.05, s * 0.75);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  disposeStone() {
    for (const o of [this.face, this.body, ...(this.bed || [])]) {
      if (!o) continue;
      this.machine.remove(o);
      o.geometry?.dispose();
      o.material?.dispose?.();
    }
    this.heightTex?.dispose(); this.maskTex?.dispose(); this.designTex?.dispose();
    this.face = this.body = null; this.bed = [];
  }

  setDesignMask(designMask) {
    if (!this.designTex) return;
    const d = this.designTex.image.data;
    for (let k = 0; k < d.length; k++) d[k] = designMask[k] ? 255 : 0;
    this.designTex.needsUpdate = true;
  }

  setStone(key) {
    const s = STONES[key] || STONES.black;
    if (!this.faceMat) return;
    const u = this.faceMat.uniforms;
    u.uBase.value.fromArray(s.base); u.uS1.value.fromArray(s.s1); u.uS2.value.fromArray(s.s2);
    u.uFrost.value.fromArray(s.frost); u.uPolish.value = s.polish; u.uVeins.value = s.veins;
    this.bodyMat.color.setHex(s.side);
  }

  /** key: a FILLS entry; for 'custom', `custom` = { color: '#rrggbb', metal: bool }. */
  setFill(key, custom = {}) {
    if (!this.faceMat) return;
    const f = FILLS[key] || FILLS.none;
    const u = this.faceMat.uniforms;
    u.uFillOn.value = key === 'none' ? 0 : 1;
    if (key === 'custom') {
      const c = new THREE.Color(custom.color || '#ffffff'); // sRGB hex -> linear
      u.uFill.value.set(c.r, c.g, c.b);
      u.uFillMetal.value = custom.metal ? 1 : 0;
    } else {
      u.uFill.value.fromArray(f.color);
      u.uFillMetal.value = f.metal;
    }
  }

  setLayout(on) { if (this.faceMat) this.faceMat.uniforms.uLayout.value = on ? 1 : 0; }

  heightChanged() { if (this.heightTex) this.heightTex.needsUpdate = true; }

  makeTool(tool) {
    const g = new THREE.Group();
    const half = (tool.angle * Math.PI) / 360;
    const R = tool.diameter / 2;
    const coneLen = R / Math.tan(half);
    const carbide = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.9, roughness: 0.25 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.8, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.3, roughness: 0.6, transparent: true, opacity: 0.55 });

    const cone = new THREE.Mesh(new THREE.ConeGeometry(R, coneLen, 48, 1, false), carbide);
    cone.rotation.x = -Math.PI / 2;            // apex toward -z
    cone.position.z = coneLen / 2;             // apex at origin
    g.add(cone);
    const bodyLen = 18;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, bodyLen, 48), carbide);
    body.rotation.x = Math.PI / 2;
    body.position.z = coneLen + bodyLen / 2;
    g.add(body);
    const shankR = Math.min(R, 6.35);
    const shank = new THREE.Mesh(new THREE.CylinderGeometry(shankR, shankR, 25, 32), steel);
    shank.rotation.x = Math.PI / 2;
    shank.position.z = coneLen + bodyLen + 12.5;
    g.add(shank);
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 22, 6), steel);
    nut.rotation.x = Math.PI / 2;
    nut.position.z = coneLen + bodyLen + 25 + 11;
    g.add(nut);
    const spindle = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 200, 48), dark);
    spindle.rotation.x = Math.PI / 2;
    spindle.position.z = coneLen + bodyLen + 25 + 22 + 100;
    g.add(spindle);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(40, 3, 8, 48), steel);
    ring.position.z = coneLen + bodyLen + 25 + 22 + 30;
    g.add(ring);
    return g;
  }

  setTool(tool) {
    const vis = this.tool.visible;
    this.machine.remove(this.tool);
    this.tool.traverse(o => { o.geometry?.dispose(); });
    this.tool = this.makeTool(tool);
    this.tool.visible = vis;
    this.machine.add(this.tool);
  }

  setToolPos(x, y, z) { this.tool.position.set(x, y, z); }

  /** Draw the program: feed moves coloured by depth, rapids faint. */
  setToolpath(P, maxDepth) {
    this.pathGroup.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); });
    this.pathGroup.clear();
    if (!P) return;
    const feed = [], fcol = [], rap = [];
    const c = new THREE.Color();
    const md = Math.max(0.1, maxDepth);
    for (let i = 1; i < P.n; i++) {
      const a = [P.X[i - 1], P.Y[i - 1], P.Z[i - 1]], b = [P.X[i], P.Y[i], P.Z[i]];
      if (P.T[i] === 0) { rap.push(...a, ...b); continue; }
      feed.push(a[0], a[1], 0.15, b[0], b[1], 0.15);
      for (const z of [a[2], b[2]]) {
        c.setHSL(0.55 - 0.55 * Math.min(1, -z / md), 0.9, 0.55);
        fcol.push(c.r, c.g, c.b);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(feed, 3));
    fg.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
    this.pathGroup.add(new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 })));
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(rap, 3));
    this.pathGroup.add(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xff5050, transparent: true, opacity: 0.25 })));
  }

  showToolpath(on) { this.pathGroup.visible = on; }
  showTool(on) { this.tool.visible = on; }

  render() {
    this.controls.update();
    if (this.faceMat) {
      const vm = this.camera.matrixWorldInverse;
      this.faceMat.uniforms.uL1.value.copy(this.light1).normalize().transformDirection(vm);
      this.faceMat.uniforms.uL2.value.copy(this.light2).normalize().transformDirection(vm);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
