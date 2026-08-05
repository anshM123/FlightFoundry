/* FlightFoundry — the test range.
   An engineering environment, not a landscape: a surveyed ground return field,
   sparse structures, and the inspection corridor the aircraft has to fly through. */

import { merge, roundedBox, cylinder, bakeAO, translate, xform } from '../lib/geo.js';
import { meshFromGeometry } from '../lib/gl.js';
import { LineSystem, PointSystem, Ribbon } from './core.js';
import { m4, trs, hexToLinear, clamp, lerp, smoothstep } from '../lib/m4.js';
import { makeRng, fbm2, fbm1 } from '../lib/rand.js';
import { RANGE } from '../sim/flight.js';

export const TERRAIN_H = (x, z) => fbm2(x * 0.0045, z * 0.0045, 4) * 9 + fbm2(x * 0.017, z * 0.017, 3) * 2.2;

const MAT = {
  steel: { base: hexToLinear('#39404a'), rough: 0.58, metal: 0.5, rimCol: hexToLinear('#7fb6c8'), rimI: 0.09 },
  dark: { base: hexToLinear('#1c2126'), rough: 0.8, metal: 0.05, rimCol: hexToLinear('#5f8b98'), rimI: 0.07 },
  paint: { base: hexToLinear('#3a3128'), rough: 0.7, metal: 0.1, rimCol: hexToLinear('#c8a06a'), rimI: 0.04 },
};

/* lattice pylon: uprights + diagonal bracing, built once and instanced by transform */
function pylon(h = 62, w = 2.3) {
  const parts = [];
  const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (const [a, b] of legs) {
    const g = roundedBox(0.22, h, 0.22, 0.05, 2);
    translate(g, a * w * 0.5, h / 2, b * w * 0.5);
    parts.push(g);
  }
  const bays = Math.floor(h / 6.0);
  for (let i = 0; i <= bays; i++) {
    const y = (i / bays) * h;
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
      const g = roundedBox(w, 0.13, 0.13, 0.04, 2);
      const len = Math.hypot((bx - ax) * w * 0.5, (bz - az) * w * 0.5);
      const ang = Math.atan2((bz - az) * w * 0.5, (bx - ax) * w * 0.5);
      const gg = roundedBox(len, 0.13, 0.13, 0.04, 2);
      xform(gg, trs(m4(), (ax + bx) * w * 0.25, y, (az + bz) * w * 0.25, 0, -ang, 0));
      parts.push(gg);
      if (i < bays) {
        const dy = h / bays;
        const dl = Math.hypot(len, dy);
        const dg = roundedBox(dl, 0.085, 0.085, 0.03, 2);
        xform(dg, trs(m4(), (ax + bx) * w * 0.25, y + dy * 0.5, (az + bz) * w * 0.25, 0, -ang, Math.atan2(dy, len) * (i % 2 ? 1 : -1)));
        parts.push(dg);
      }
    }
  }
  return merge(parts);
}

export function createWorld(gl, { quality = 2 } = {}) {
  const rng = makeRng(9931);

  /* ---------------- ground return field ---------------- */
  const stepX = quality > 1 ? 4.6 : 7.5, stepZ = quality > 1 ? 5.0 : 8.0;
  const x0 = -70, x1 = 380, z0 = -190, z1 = 190;
  const nx = Math.floor((x1 - x0) / stepX), nz = Math.floor((z1 - z0) / stepZ);
  const ground = new PointSystem(gl, nx * nz);
  let gi = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = x0 + i * stepX + rng.range(-2.4, 2.4);
    const z = z0 + j * stepZ + rng.range(-2.6, 2.6);
    ground.P[gi * 3] = x; ground.P[gi * 3 + 1] = TERRAIN_H(x, z); ground.P[gi * 3 + 2] = z;
    /* returns thin out with lateral distance from the surveyed corridor */
    const d = Math.abs(z - RANGE.gapZ);
    ground.M[gi * 3] = lerp(0.95, 0.42, clamp(d / 190, 0, 1)) * rng.range(0.7, 1.25);
    ground.M[gi * 3 + 1] = 0;
    ground.M[gi * 3 + 2] = rng.next();
    gi++;
  }
  ground.sync(gi);

  /* ---------------- survey contour lines ---------------- */
  const contours = [];
  for (let k = 0; k < 17; k++) {
    const z = lerp(z0 + 12, z1 - 12, k / 16);
    const n = 90;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = lerp(x0, x1, i / (n - 1));
      pts[i * 3] = x; pts[i * 3 + 1] = TERRAIN_H(x, z) + 0.05; pts[i * 3 + 2] = z;
    }
    contours.push({ pts, meta: [Math.abs(z - RANGE.gapZ) / 190, 0, 0] });
  }
  const contourSys = new LineSystem(gl, contours);

  /* ---------------- the inspection corridor ---------------- */
  const structParts = [];
  const gateZ = [RANGE.gapZ - RANGE.gapHalf - 1.15, RANGE.gapZ + RANGE.gapHalf + 1.15];
  const frames = 3;
  const py = pylon(RANGE.alt + 9, 2.6);
  for (let f = 0; f < frames; f++) {
    const x = RANGE.gateX - RANGE.gateDepth / 2 + (f / (frames - 1)) * RANGE.gateDepth;
    for (const z of gateZ) {
      const g = { position: py.position.slice(), normal: py.normal.slice(), uv: py.uv.slice(), aux: py.aux ? py.aux.slice() : null, index: py.index };
      translate(g, x, TERRAIN_H(x, z), z);
      structParts.push({ ...g, index: py.index });
    }
    /* upper cross member spanning the corridor */
    const span = gateZ[1] - gateZ[0] + 2.3;
    const cm = roundedBox(1.5, 0.9, span, 0.16, 2);
    translate(cm, x, RANGE.alt + 8, RANGE.gapZ);
    structParts.push(cm);
  }
  /* longitudinal rails tying the frames together */
  for (const z of gateZ) for (const y of [RANGE.alt + 8, RANGE.alt - 11]) {
    const r = roundedBox(RANGE.gateDepth + 2.3, 0.42, 0.42, 0.1, 2);
    translate(r, RANGE.gateX, y, z);
    structParts.push(r);
  }
  /* the thin cross member that is hard to see in low contrast — the actual hazard */
  const thin = roundedBox(0.5, 0.16, RANGE.gapHalf * 2 + 2.3, 0.05, 2);
  translate(thin, RANGE.gateX - RANGE.gateDepth / 2 - 0.4, RANGE.alt + 3.4, RANGE.gapZ);
  structParts.push(thin);

  /* ---------------- other range furniture ---------------- */
  const props = [];
  const layout = [
    [58, -34, 'mast'], [104, 46, 'block'], [150, -62, 'mast'], [186, 38, 'gantry'],
    [24, 52, 'block'], [268, -48, 'mast'], [312, 30, 'block'], [82, 78, 'mast'],
  ];
  for (const [x, z, kind] of layout) {
    const y = TERRAIN_H(x, z);
    if (kind === 'mast') {
      const g = cylinder(0.34, 0.22, 26, 10, true);
      translate(g, x, y + 13, z);
      props.push(g);
      const top = roundedBox(2.6, 0.24, 0.24, 0.06, 2);
      translate(top, x, y + 25, z);
      props.push(top);
    } else if (kind === 'block') {
      const g = roundedBox(12, 4.2, 5.2, 0.28, 2);
      translate(g, x, y + 2.1, z);
      props.push(g);
      const g2 = roundedBox(6.4, 2.6, 4.4, 0.2, 2);
      translate(g2, x + 3, y + 5.5, z + 0.4);
      props.push(g2);
    } else {
      const a = cylinder(0.4, 0.35, 17, 10, true); translate(a, x, y + 8.5, z - 6); props.push(a);
      const b = cylinder(0.4, 0.35, 17, 10, true); translate(b, x, y + 8.5, z + 6); props.push(b);
      const c = roundedBox(1.1, 0.7, 13, 0.16, 2); translate(c, x, y + 17, z); props.push(c);
    }
  }

  const gStruct = merge(structParts);
  const gProps = merge(props);
  const structMesh = meshFromGeometry(gl, gStruct);
  const propMesh = meshFromGeometry(gl, gProps);

  /* ---------------- wind field ---------------- */
  const WIND_N = quality > 1 ? 260 : 110;
  const SEG = 3;
  const windPolys = [];
  const windPts = new Float32Array((SEG + 1) * 3);
  for (let i = 0; i < WIND_N; i++) windPolys.push({ pts: windPts, count: SEG + 1, meta: [i / WIND_N, 0, 0] });
  const wind = new LineSystem(gl, windPolys, { dynamic: true });
  const windSeed = [];
  for (let i = 0; i < WIND_N; i++) {
    windSeed.push({ x: rng.range(-40, 340), y: rng.range(20, 62), z: rng.range(-90, 90), p: rng.next() });
  }

  function updateWind(t, strength, focusX) {
    let s = 0;
    for (let i = 0; i < WIND_N; i++) {
      const w = windSeed[i];
      const life = (t * 0.22 + w.p) % 1;
      const bx = w.x + life * 60 - 30;
      const drift = fbm1(w.z * 0.02 + t * 0.35, 2) * 5;
      for (let k = 0; k < SEG; k++) {
        const u0 = k / SEG, u1 = (k + 1) / SEG;
        const l0 = 5.4 * strength, l1 = l0;
        const ax = bx - u0 * l1 * 2.4, bx2 = bx - u1 * l1 * 2.4;
        const az = w.z - strength * 2.2 * u0 * 4 + drift, bz2 = w.z - strength * 2.2 * u1 * 4 + drift;
        wind.A[s * 3] = ax; wind.A[s * 3 + 1] = w.y + Math.sin(u0 * 3 + t) * 0.5; wind.A[s * 3 + 2] = az;
        wind.B[s * 3] = bx2; wind.B[s * 3 + 1] = w.y + Math.sin(u1 * 3 + t) * 0.5; wind.B[s * 3 + 2] = bz2;
        wind.M[s * 3] = Math.abs(bx - focusX) / 220;
        wind.M[s * 3 + 1] = 0;
        wind.M[s * 3 + 2] = 0;
        wind.T[s * 2] = u0; wind.T[s * 2 + 1] = u1;
        s++;
      }
    }
    wind.count = s;
    wind.syncAll();
  }

  return {
    ground, contourSys, structMesh, propMesh, wind, updateWind, MAT,
    gateZ,
    drawSolids(stage, opts = {}) {
      const p = stage.beginSurfacePass();
      const I = trs(m4(), 0, 0, 0, 0, 0, 0);
      stage.drawSurface(structMesh, I, { ...MAT.steel, ao: 0.4, opacity: opts.opacity ?? 1, reveal: opts.reveal ?? 1 });
      stage.drawSurface(propMesh, I, { ...MAT.dark, ao: 0.4, opacity: opts.opacity ?? 1, reveal: opts.reveal ?? 1 });
    },
  };
}
