/* FlightFoundry — the analysis systems.
   Scenario field, causal graph, protected evaluation, regression sweep, improvement loop.
   Each region lives at its own station in one continuous world so the film never cuts scenes. */

import { merge, roundedBox, cylinder, torus, sphere, bakeAO, translate, xform, loft } from '../lib/geo.js';
import { meshFromGeometry } from '../lib/gl.js';
import { LineSystem, PointSystem } from './core.js';
import { m4, trs, hexToLinear, clamp, lerp, smoothstep, v3 } from '../lib/m4.js';
import { makeRng } from '../lib/rand.js';
import { RANGE, failLimit } from '../sim/flight.js';

export const STATION = {
  field: [900, 30, 0],
  causal: [1900, 26, 0],
  vault: [2900, 40, 0],
  loop: [3900, 26, 0],
};

const COL = {
  pass: hexToLinear('#7f9aa6'),
  fail: hexToLinear('#d4574c'),
  sig: hexToLinear('#8fd3e2'),
  ok: hexToLinear('#6fbe96'),
  warn: hexToLinear('#dda24c'),
  dim: hexToLinear('#3b4750'),
};
export { COL };

/* ------------------------------------------------------------------ */
/* Scenario field — every glyph is one executed simulation             */
/* ------------------------------------------------------------------ */
export function createField(gl, fs, { scale = 240, glyph = 34, quality = 2 } = {}) {
  const n = fs.count;
  const O = STATION.field;
  const pos = new Float32Array(3);

  /* survivor ordering: nearest-to-minimal failures survive longest under reduction */
  const order = [];
  const seen = new Uint8Array(n);
  for (const i of fs.mechIdx) { order.push(i); seen[i] = 1; }
  const restFail = fs.failIdx.filter((i) => !seen[i]).sort((a, b) => fs.dist[a] - fs.dist[b]);
  for (const i of restFail) { order.push(i); seen[i] = 1; }
  const passes = [];
  for (let i = 0; i < n; i++) if (!seen[i]) passes.push(i);
  passes.sort((a, b) => fs.dist[a] - fs.dist[b]);
  for (const i of passes) order.push(i);
  const rank = new Float32Array(n);
  for (let k = 0; k < order.length; k++) rank[order[k]] = k;

  const SEG = quality > 1 ? 9 : 6;
  const polys = [];
  const pts = new Float32Array((SEG + 1) * 3);
  const centres = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    fs.embed.place(fs.scenarios[i], pos, scale);
    const cx = O[0] + pos[0], cy = O[1] + pos[1] * 0.62, cz = O[2] + pos[2];
    centres[i * 3] = cx; centres[i * 3 + 1] = cy; centres[i * 3 + 2] = cz;
    const fail = fs.failed[i];
    const stop = fail ? clamp(fs.failFrac[i], 0.25, 1) : 1;
    const lat = clamp(fs.zGate[i], -6, 6) * 0.55;
    const p = new Float32Array((SEG + 1) * 3);
    for (let k = 0; k <= SEG; k++) {
      const u = (k / SEG) * stop;
      p[k * 3] = cx + (u - 0.5) * glyph;
      p[k * 3 + 1] = cy + Math.sin(u * 2.1) * 0.5;
      p[k * 3 + 2] = cz + smoothstep(0.25, 1.0, u) * lat;
    }
    polys.push({ pts: p, meta: [rank[i] / n, fail, i / n] });
  }
  const lines = new LineSystem(gl, polys);

  /* failure density: additive points only where runs actually terminated */
  const dens = new PointSystem(gl, fs.failIdx.length * 3);
  let d = 0;
  const rng = makeRng(4211);
  for (const i of fs.failIdx) {
    for (let k = 0; k < 3; k++) {
      dens.P[d * 3] = centres[i * 3] + rng.range(-9, 9);
      dens.P[d * 3 + 1] = centres[i * 3 + 1] + rng.range(-7, 7);
      dens.P[d * 3 + 2] = centres[i * 3 + 2] + rng.range(-9, 9);
      dens.M[d * 3] = 7.5 + rng.range(-2, 4);
      dens.M[d * 3 + 1] = 1;
      dens.M[d * 3 + 2] = rng.next();
      d++;
    }
  }
  dens.sync(d);

  return { lines, dens, centres, rank, order, scale, origin: O };
}

/* ------------------------------------------------------------------ */
/* Causal graph                                                        */
/* ------------------------------------------------------------------ */
export const CAUSAL_NODES = [
  { id: 'cam', label: 'CAMERA', sub: 'low-contrast observation' },
  { id: 'perc', label: 'PERCEPTION', sub: 'range confidence falls' },
  { id: 'est', label: 'STATE ESTIMATION', sub: 'corridor position bias' },
  { id: 'plan', label: 'PLANNING', sub: 'commits late, on a bad estimate' },
  { id: 'ctrl', label: 'CONTROL', sub: 'lateral authority saturates' },
  { id: 'veh', label: 'VEHICLE', sub: 'loss of separation' },
];

export function createCausal(gl) {
  const O = STATION.causal;
  const N = CAUSAL_NODES.length;
  const span = 190;
  const nodes = CAUSAL_NODES.map((nd, i) => {
    const u = i / (N - 1);
    return {
      ...nd,
      p: [O[0] + (u - 0.5) * span, O[1] + Math.sin(u * Math.PI) * 16 - 6, O[2] + (i % 2 ? 9 : -9)],
    };
  });
  const plate = roundedBox(15, 5.2, 15, 1.1, 3);
  bakeAO([plate], plate, { res: 28, rays: 8, steps: 5, radius: 6, strength: 0.8 });
  const plateMesh = meshFromGeometry(gl, plate);
  const ring = meshFromGeometry(gl, torus(11.5, 0.35, 40, 6));

  const polys = [];
  for (let i = 0; i < N - 1; i++) {
    const a = nodes[i].p, b = nodes[i + 1].p;
    const K = 14;
    const p = new Float32Array((K + 1) * 3);
    for (let k = 0; k <= K; k++) {
      const u = k / K, e = smoothstep(0, 1, u);
      p[k * 3] = lerp(a[0], b[0], u);
      p[k * 3 + 1] = lerp(a[1], b[1], e) + Math.sin(u * Math.PI) * 3.2;
      p[k * 3 + 2] = lerp(a[2], b[2], e);
    }
    polys.push({ pts: p, meta: [i / (N - 1), 0, i] });
  }
  const edges = new LineSystem(gl, polys);
  return { nodes, edges, plateMesh, ring, origin: O };
}

/* ------------------------------------------------------------------ */
/* Protected evaluation — an opaque machined monolith                  */
/* ------------------------------------------------------------------ */
export function createVault(gl) {
  const O = STATION.vault;
  const W = 92, H = 132, D = 74, R = Math.max(W, D) * 0.5;
  const parts = [];
  /* one chamfered monolith, then machined detail: recessed bands, corner ribs, a sealed lid */
  parts.push(roundedBox(W, H, D, 5.5, 4));
  const lid = roundedBox(W * 0.82, 9, D * 0.82, 3, 3); translate(lid, 0, H * 0.5 + 4, 0); parts.push(lid);
  const base = roundedBox(W * 0.9, 7, D * 0.9, 3, 3); translate(base, 0, -H * 0.5 - 3, 0); parts.push(base);
  for (const y of [-H * 0.26, H * 0.26]) {
    const band = roundedBox(W * 1.012, 3.2, D * 1.012, 1.0, 2);
    translate(band, 0, y, 0); parts.push(band);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const rib = roundedBox(7, H + 6, 7, 2.2, 3);
    translate(rib, sx * W * 0.5, 0, sz * D * 0.5); parts.push(rib);
  }
  /* shallow inspection ports — sealed, never open */
  for (let i = 0; i < 5; i++) {
    const port = roundedBox(2.6, 9, 9, 1.4, 2);
    translate(port, -W * 0.5 - 0.6, H * 0.30 - i * 12, D * 0.22);
    parts.push(port);
  }
  const g = merge(parts);
  bakeAO([g], g, { res: 64, rays: 12, radius: 11, strength: 0.85 });
  translate(g, O[0], O[1], O[2]);
  const mesh = meshFromGeometry(gl, g);

  /* interior traces: never resolve into anything readable */
  const rng = makeRng(8817);
  const polys = [];
  for (let i = 0; i < 70; i++) {
    const K = 10;
    const p = new Float32Array((K + 1) * 3);
    const a0 = rng.range(0, Math.PI * 2), r0 = rng.range(6, R * 0.72), y0 = rng.range(-H * 0.42, H * 0.42);
    const dz = rng.range(-1, 1), da = rng.range(-0.8, 0.8);
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      const a = a0 + da * u, r = r0 * (1 - u * 0.25);
      p[k * 3] = O[0] + Math.cos(a) * r;
      p[k * 3 + 1] = O[1] + y0 + dz * 26 * u;
      p[k * 3 + 2] = O[2] + Math.sin(a) * r;
    }
    polys.push({ pts: p, meta: [i / 70, 0, rng.next()] });
  }
  const traces = new LineSystem(gl, polys);

  /* regression sweep results: one marker per evaluation scenario */
  const RES = 700;
  const results = new PointSystem(gl, RES);
  const cols = 35;
  for (let i = 0; i < RES; i++) {
    const c = i % cols, r = (i / cols) | 0;
    results.P[i * 3] = O[0] + (c - cols / 2) * 3.6;
    results.P[i * 3 + 1] = O[1] - H * 0.5 - 28 - r * 3.6;
    results.P[i * 3 + 2] = O[2] + 56;
    results.M[i * 3] = 3.4;
    results.M[i * 3 + 1] = 0;
    results.M[i * 3 + 2] = i / RES;
  }
  results.sync(RES);

  /* the constrained feedback channel used in the SEAL panel */
  const chan = [];
  for (let i = 0; i < 3; i++) {
    const K = 24;
    const p = new Float32Array((K + 1) * 3);
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      p[k * 3] = O[0] + R * 0.98 + u * 150;
      p[k * 3 + 1] = O[1] + (i - 1) * 4 * (1 - u * 0.55) + Math.sin(u * 5 + i) * 1.6;
      p[k * 3 + 2] = O[2] + (i - 1) * 3 * (1 - u * 0.8);
    }
    chan.push({ pts: p, meta: [i / 3, 0, i] });
  }
  const channel = new LineSystem(gl, chan);

  return { mesh, traces, results, channel, origin: O, R, H, W, D, RES };
}

/* ------------------------------------------------------------------ */
/* Improvement loop                                                    */
/* ------------------------------------------------------------------ */
export const LOOP_STAGES = ['DISCOVER', 'ISOLATE', 'DIAGNOSE', 'REPAIR', 'VERIFY', 'RELEASE', 'FLIGHT'];

export function createLoop(gl) {
  const O = STATION.loop;
  const R = 128;
  const K = 260;
  const p = new Float32Array((K + 1) * 3);
  for (let k = 0; k <= K; k++) {
    const a = (k / K) * Math.PI * 2 - Math.PI / 2;
    p[k * 3] = O[0] + Math.cos(a) * R;
    p[k * 3 + 1] = O[1] + Math.sin(a) * R * 0.34;
    p[k * 3 + 2] = O[2] - Math.sin(a) * R * 0.86;
  }
  const ring = new LineSystem(gl, [{ pts: p, meta: [0, 0, 0] }]);

  const stations = LOOP_STAGES.map((label, i) => {
    const a = (i / LOOP_STAGES.length) * Math.PI * 2 - Math.PI / 2;
    return {
      label,
      p: [O[0] + Math.cos(a) * R, O[1] + Math.sin(a) * R * 0.34, O[2] - Math.sin(a) * R * 0.86],
      t: i / LOOP_STAGES.length,
    };
  });
  const marker = roundedBox(9, 9, 9, 1.4, 3);
  bakeAO([marker], marker, { res: 24, rays: 8, steps: 5, radius: 4, strength: 0.8 });
  const markerMesh = meshFromGeometry(gl, marker);
  return { ring, stations, markerMesh, origin: O, R };
}

/* ------------------------------------------------------------------ */
/* Disassembly: the flight opened up, with time as the spatial axis     */
/* ------------------------------------------------------------------ */
export function createSignals(gl, rec, { lanes = null } = {}) {
  const L = lanes || [
    { key: 'conf', label: 'PERCEPTION CONFIDENCE', y: 26, scale: 16, base: 0, flag: 0 },
    { key: 'P', label: 'STATE UNCERTAINTY', y: 46, scale: 0.55, base: 0, flag: 0 },
    { key: 'zHat', label: 'ESTIMATED CORRIDOR CENTRE', y: 66, scale: 1.8, base: RANGE.gapZ, flag: 0 },
    { key: 'zRef', label: 'COMMANDED LATERAL TARGET', y: 84, scale: 1.8, base: RANGE.gapZ, flag: 0 },
    { key: 'effort', label: 'CONTROL EFFORT', y: 102, scale: 15, base: 0, flag: 0 },
    { key: 'satF', label: 'ACTUATOR SATURATION', y: 118, scale: 9, base: 0, flag: 1 },
  ];
  const polys = [];
  const step = Math.max(1, Math.floor(rec.n / 220));
  for (let li = 0; li < L.length; li++) {
    const lane = L[li];
    const arr = rec[lane.key];
    const cnt = Math.floor(rec.n / step);
    const p = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) {
      const k = i * step;
      p[i * 3] = rec.x[k];
      p[i * 3 + 1] = lane.y + (arr[k] - lane.base) * lane.scale;
      p[i * 3 + 2] = 0;
    }
    polys.push({ pts: p, meta: [li / L.length, lane.flag, li] });
  }
  /* baselines */
  for (let li = 0; li < L.length; li++) {
    const lane = L[li];
    const p = new Float32Array(2 * 3);
    p[0] = rec.x[0]; p[1] = lane.y; p[2] = 0;
    p[3] = rec.x[rec.n - 1]; p[4] = lane.y; p[5] = 0;
    polys.push({ pts: p, meta: [li / L.length, 0, 100 + li] });
  }
  const sys = new LineSystem(gl, polys);
  return { sys, lanes: L, count: polys.length };
}
