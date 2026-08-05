/* FlightFoundry — the aircraft.
 * A quadplane VTOL: high wing on genuine NACA sections, twin booms, four lift rotors,
 * a pusher propeller, a V-tail, a gimballed EO turret and a lidar puck. Every surface is
 * generated from engineering-plausible parameters. Nothing is imported.
 * Frame: +X forward, +Y up, +Z starboard. Semi-span 1.35 m, matching the simulation.
 */

import { merge, loft, naca4, roundedBox, cylinder, sphere, torus, xform, translate, scaleGeo, disc, bakeAO } from '../lib/geo.js';
import { meshFromGeometry } from '../lib/gl.js';
import { m4, trs, identity, mul, hexToLinear, clamp, lerp } from '../lib/m4.js';

const MAT = {
  carbon:  { base: hexToLinear('#2a3037'), rough: 0.52, metal: 0.06, rimCol: hexToLinear('#9fd6e8'), rimI: 0.10, wire: 0 },
  shell:   { base: hexToLinear('#3a424b'), rough: 0.40, metal: 0.10, rimCol: hexToLinear('#8fd3e2'), rimI: 0.11 },
  alu:     { base: hexToLinear('#a2aab3'), rough: 0.28, metal: 0.92, rimCol: hexToLinear('#cfe6ee'), rimI: 0.09 },
  polymer: { base: hexToLinear('#1a1e23'), rough: 0.74, metal: 0.02, rimCol: hexToLinear('#5f8b98'), rimI: 0.09 },
  glass:   { base: hexToLinear('#0a1015'), rough: 0.07, metal: 0.25, opacity: 0.92, rimCol: hexToLinear('#a9e4f2'), rimI: 0.30 },
  blade:   { base: hexToLinear('#242a30'), rough: 0.42, metal: 0.08, rimCol: hexToLinear('#9fd6e4'), rimI: 0.14 },
  led:     { base: hexToLinear('#0a0d10'), rough: 0.4, metal: 0, emis: hexToLinear('#8fd3e2'), emisI: 2.6 },
};

/* ---- fuselage: lofted superellipse sections ---- */
function fuselage() {
  const stations = [
    [-0.660, 0.013, 0.012, 3.2], [-0.628, 0.038, 0.034, 3.0], [-0.575, 0.062, 0.056, 2.9],
    [-0.490, 0.080, 0.073, 2.8], [-0.360, 0.092, 0.084, 2.8], [-0.190, 0.097, 0.089, 2.8],
    [0.000, 0.096, 0.088, 2.8], [0.160, 0.090, 0.082, 2.9], [0.310, 0.077, 0.070, 3.0],
    [0.450, 0.060, 0.055, 3.2], [0.570, 0.045, 0.042, 3.4], [0.680, 0.034, 0.033, 3.6],
    [0.780, 0.029, 0.029, 3.8], [0.860, 0.027, 0.027, 4.0],
  ];
  const N = 18;
  const sections = stations.map(([x, w, h, p]) => {
    const ring = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const py = Math.sign(s) * Math.pow(Math.abs(s), 2 / p) * h;
      const pz = Math.sign(c) * Math.pow(Math.abs(c), 2 / p) * w;
      ring.push([x, py * (py < 0 ? 0.88 : 1) + 0.012, pz]);
    }
    return ring;
  });
  return loft(sections, { closedRing: true, capStart: true, capEnd: true });
}

/* ---- wing: NACA 2412, taper, sweep, dihedral, washout ---- */
function wing({ semi = 1.35, rootChord = 0.30, tipChord = 0.185, code = '2412' } = {}) {
  const prof = naca4(code, 26);
  const S = 13;
  const sections = [];
  for (let i = 0; i < S; i++) {
    const u = (i / (S - 1)) * 2 - 1;        /* -1 .. 1 across the span */
    const a = Math.abs(u);
    const z = u * semi;
    const chord = lerp(rootChord, tipChord, Math.pow(a, 1.25));
    const sweep = 0.062 * Math.pow(a, 1.5);
    const dih = 0.058 * Math.pow(a, 1.35);
    const twist = -0.055 * a * a;           /* washout: tip stalls last */
    const c = Math.cos(twist), s = Math.sin(twist);
    sections.push(prof.map(([px, py]) => {
      const x0 = (px - 0.27) * chord, y0 = py * chord;
      return [x0 * c - y0 * s + sweep - 0.02, x0 * s + y0 * c + dih + 0.118, z];
    }));
  }
  return loft(sections, { closedRing: true, capStart: true, capEnd: true });
}

/* V-tail panel: built in its own frame so the section stays perpendicular to the spar */
function tailSurface(sign, phi = 0.86, len = 0.315) {
  const prof = naca4('0010', 18);
  const S = 6;
  const ux = 0, uy = Math.sin(phi), uz = sign * Math.cos(phi);          /* spar direction */
  const nx = 0, ny = -sign * Math.cos(phi), nz = Math.sin(phi);         /* surface normal */
  const rootX = 0.655, rootY = 0.052;
  const sections = [];
  for (let i = 0; i < S; i++) {
    const u = i / (S - 1);
    const chord = lerp(0.190, 0.098, Math.pow(u, 1.15));
    const r = u * len;
    const sweep = 0.085 * Math.pow(u, 1.15);
    sections.push(prof.map(([px, py]) => {
      const cx = (px - 0.24) * chord, t = py * chord;
      return [
        rootX + sweep + cx + ux * r + nx * t,
        rootY + uy * r + ny * t,
        uz * r + nz * t,
      ];
    }));
  }
  return loft(sections, { closedRing: true, capStart: true, capEnd: true });
}

function propBlade({ R = 0.235, root = 0.028 } = {}) {
  const prof = naca4('0012', 14);
  const S = 8;
  const sections = [];
  for (let i = 0; i < S; i++) {
    const u = i / (S - 1);
    const r = lerp(root, R, u);
    const chord = lerp(0.052, 0.024, Math.pow(u, 0.8)) * (u > 0.92 ? 0.6 : 1);
    const twist = lerp(0.42, 0.11, u);      /* real props are twisted */
    const c = Math.cos(twist), s = Math.sin(twist);
    sections.push(prof.map(([px, py]) => {
      const x0 = (px - 0.32) * chord, y0 = py * chord;
      return [x0 * c - y0 * s, x0 * s + y0 * c, r];
    }));
  }
  return loft(sections, { closedRing: true, capStart: true, capEnd: true });
}

function motorPod() {
  const parts = [];
  const can = cylinder(0.041, 0.038, 0.052, 20, true);
  xform(can, trs(m4(), 0, 0, 0, 0, 0, 0));
  parts.push(can);
  /* cooling fins */
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const f = roundedBox(0.006, 0.040, 0.014, 0.002, 2);
    xform(f, trs(m4(), Math.cos(a) * 0.043, 0, Math.sin(a) * 0.043, 0, -a, 0));
    parts.push(f);
  }
  const bell = cylinder(0.030, 0.020, 0.020, 18, true);
  translate(bell, 0, 0.036, 0);
  parts.push(bell);
  return merge(parts);
}

export function createAircraft(gl) {
  /* ---------- static, merged by material ---------- */
  const carbonParts = [];
  const shellParts = [];
  const aluParts = [];
  const polyParts = [];
  const glassParts = [];

  shellParts.push(fuselage());
  carbonParts.push(wing());
  carbonParts.push(tailSurface(1), tailSurface(-1));

  /* booms */
  for (const z of [-0.60, 0.60]) {
    const b = roundedBox(1.30, 0.052, 0.048, 0.016, 3);
    translate(b, 0.03, 0.086, z);
    carbonParts.push(b);
    /* boom-to-wing fairings */
    for (const x of [-0.30, 0.36]) {
      const f = roundedBox(0.10, 0.062, 0.056, 0.02, 3);
      translate(f, x, 0.106, z);
      shellParts.push(f);
    }
  }

  /* wing spar caps / fasteners */
  for (let i = 0; i < 14; i++) {
    const z = lerp(-1.2, 1.2, i / 13);
    const f = cylinder(0.0075, 0.0075, 0.006, 8, true);
    translate(f, -0.02 + Math.abs(z / 1.35) * 0.062, 0.152 + 0.058 * Math.pow(Math.abs(z) / 1.35, 1.35), z);
    aluParts.push(f);
  }

  /* landing skids */
  for (const z of [-0.34, 0.34]) {
    const s = roundedBox(0.60, 0.018, 0.016, 0.008, 2);
    translate(s, 0.02, -0.145, z);
    carbonParts.push(s);
    for (const x of [-0.20, 0.22]) {
      const leg = roundedBox(0.020, 0.10, 0.018, 0.007, 2);
      xform(leg, trs(m4(), x, -0.088, z * 0.86, 0, 0, z > 0 ? -0.22 : 0.22));
      polyParts.push(leg);
    }
  }

  /* nose EO turret mount + lidar puck + antenna + pitot */
  const mountArm = roundedBox(0.075, 0.055, 0.056, 0.014, 3);
  translate(mountArm, -0.355, -0.030, 0);
  shellParts.push(mountArm);
  const collar = cylinder(0.040, 0.036, 0.016, 18, true);
  translate(collar, -0.355, -0.052, 0);
  aluParts.push(collar);

  /* dorsal avionics spine */
  const spine = roundedBox(0.46, 0.030, 0.088, 0.012, 3);
  translate(spine, 0.06, 0.108, 0);
  carbonParts.push(spine);
  const hatch = roundedBox(0.15, 0.010, 0.070, 0.004, 2);
  translate(hatch, -0.20, 0.100, 0);
  shellParts.push(hatch);

  const puck = cylinder(0.052, 0.048, 0.030, 22, true);
  translate(puck, -0.06, 0.135, 0);
  polyParts.push(puck);
  const puckBand = cylinder(0.054, 0.054, 0.011, 22, false);
  translate(puckBand, -0.06, 0.138, 0);
  glassParts.push(puckBand);

  const ant = roundedBox(0.012, 0.085, 0.006, 0.003, 2);
  xform(ant, trs(m4(), 0.30, 0.155, 0, 0, 0, -0.18));
  polyParts.push(ant);

  const pitot = cylinder(0.0055, 0.0035, 0.13, 8, true);
  xform(pitot, trs(m4(), -0.70, 0.035, 0, 0, 0, Math.PI / 2));
  aluParts.push(pitot);

  /* vents */
  for (let i = 0; i < 5; i++) {
    const v = roundedBox(0.012, 0.026, 0.004, 0.0015, 2);
    translate(v, 0.20 + i * 0.022, 0.075, 0.092);
    polyParts.push(v);
    const v2 = roundedBox(0.012, 0.026, 0.004, 0.0015, 2);
    translate(v2, 0.20 + i * 0.022, 0.075, -0.092);
    polyParts.push(v2);
  }

  /* status indicator */
  const led = sphere(0.0075, 10, 8);
  translate(led, 0.13, 0.152, 0);
  const ledGeo = led;

  /* motor pods at the four boom stations */
  const POD = [[-0.46, -0.60], [-0.46, 0.60], [0.52, -0.60], [0.52, 0.60]];
  for (const [x, z] of POD) {
    const pod = motorPod();
    translate(pod, x, 0.126, z);
    aluParts.push(pod);
    const mount = roundedBox(0.085, 0.030, 0.070, 0.012, 2);
    translate(mount, x, 0.106, z);
    shellParts.push(mount);
  }

  /* pusher motor at the tail */
  const pusherCan = cylinder(0.036, 0.033, 0.046, 18, true);
  xform(pusherCan, trs(m4(), 0.885, 0.030, 0, 0, 0, Math.PI / 2));
  aluParts.push(pusherCan);

  const gCarbon = merge(carbonParts), gShell = merge(shellParts), gAlu = merge(aluParts),
        gPoly = merge(polyParts), gGlass = merge(glassParts);
  /* occlusion is baked against the whole airframe, so parts shadow each other */
  bakeAO([gCarbon, gShell, gAlu, gPoly, gGlass], merge([gCarbon, gShell, gAlu, gPoly]),
    { res: 72, rays: 13, radius: 0.34, strength: 0.85 });

  const meshes = {
    carbon: meshFromGeometry(gl, gCarbon),
    shell: meshFromGeometry(gl, gShell),
    alu: meshFromGeometry(gl, gAlu),
    poly: meshFromGeometry(gl, gPoly),
    glass: meshFromGeometry(gl, gGlass),
    led: meshFromGeometry(gl, ledGeo),
    blade: meshFromGeometry(gl, propBlade()),
    pusherBlade: meshFromGeometry(gl, propBlade({ R: 0.195, root: 0.024 })),
    hub: meshFromGeometry(gl, cylinder(0.019, 0.014, 0.022, 14, true)),
    disc: meshFromGeometry(gl, disc(0.238, 40)),
    pusherDisc: meshFromGeometry(gl, disc(0.198, 32)),
    turret: meshFromGeometry(gl, merge([sphere(0.062, 20, 14), (() => { const g = cylinder(0.030, 0.030, 0.020, 16, true); xform(g, trs(m4(), -0.052, -0.010, 0, 0, 0, Math.PI / 2)); return g; })()])),
    lens: meshFromGeometry(gl, (() => { const g = cylinder(0.026, 0.024, 0.008, 18, true); xform(g, trs(m4(), -0.062, -0.010, 0, 0, 0, Math.PI / 2)); return g; })()),
    ail: meshFromGeometry(gl, (() => {
      return roundedBox(0.062, 0.0085, 0.40, 0.0035, 2);
    })()),
  };

  const M = m4(), T = m4(), W = m4();
  const state = { rpm: 0, pusher: 0, aileron: 0, gimbal: 0, reveal: 1, opacity: 1, cut: null, spin: 0, spinP: 0 };

  function tick(dt, s) {
    Object.assign(state, s);
    state.spin += state.rpm * dt * 26;
    state.spinP += state.pusher * dt * 34;
  }

  function draw(stage, model, over = {}) {
    const p = stage.beginSurfacePass();
    const rev = over.reveal ?? state.reveal;
    const op = over.opacity ?? state.opacity;
    const cut = over.cut || null;
    const base = { reveal: rev, opacity: op, cut: cut ? cut : undefined };

    stage.drawSurface(meshes.shell, model, { ...MAT.shell, ...base });
    stage.drawSurface(meshes.carbon, model, { ...MAT.carbon, ...base });
    stage.drawSurface(meshes.alu, model, { ...MAT.alu, ...base });
    stage.drawSurface(meshes.poly, model, { ...MAT.polymer, ...base });
    stage.drawSurface(meshes.led, model, { ...MAT.led, ...base, emisI: MAT.led.emisI * (over.ledI ?? 1) });

    /* gimballed turret */
    mul(W, model, trs(T, -0.36, -0.075, 0, 0, state.gimbal * 0.5, state.gimbal * 0.22));
    stage.drawSurface(meshes.turret, W, { ...MAT.polymer, ...base });
    stage.drawSurface(meshes.lens, W, { ...MAT.glass, ...base, opacity: op });

    /* ailerons deflect with commanded roll */
    for (const z of [-1.02, 1.02]) {
      const d = state.aileron * (z > 0 ? 1 : -1);
      const a = Math.abs(z) / 1.35;
      const chord = lerp(0.30, 0.185, Math.pow(a, 1.25));
      const teX = (1 - 0.27) * chord + 0.062 * Math.pow(a, 1.5) - 0.02;
      mul(W, model, trs(T, teX + 0.030, 0.118 + 0.058 * Math.pow(a, 1.35) - 0.004 * (z > 0 ? 1 : 1), z, 0, 0, d));
      stage.drawSurface(meshes.ail, W, { ...MAT.carbon, ...base, wire: 0 });
    }

    /* lift rotors */
    const POD2 = [[-0.46, -0.60, 1], [-0.46, 0.60, -1], [0.52, -0.60, -1], [0.52, 0.60, 1]];
    for (let i = 0; i < POD2.length; i++) {
      const [x, z, dir] = POD2[i];
      const ang = state.spin * dir + i * 1.31;
      mul(W, model, trs(T, x, 0.168, z, 0, 0, 0));
      stage.drawSurface(meshes.hub, W, { ...MAT.alu, ...base });
      for (let b = 0; b < 2; b++) {
        mul(W, model, trs(T, x, 0.168, z, 0, ang + b * Math.PI, 0));
        stage.drawSurface(meshes.blade, W, { ...MAT.blade, ...base, opacity: op * (1 - clamp(state.rpm, 0, 1) * 0.55) });
      }
    }

    /* pusher */
    for (let b = 0; b < 2; b++) {
      mul(W, model, trs(T, 0.915, 0.030, 0, state.spinP + b * Math.PI, 0, Math.PI / 2));
      stage.drawSurface(meshes.pusherBlade, W, { ...MAT.blade, ...base, opacity: op * (1 - clamp(state.pusher, 0, 1) * 0.5) });
    }
  }

  /* the translucent swept disc that a spinning rotor actually looks like */
  function drawDiscs(stage, model, alphaMul = 1) {
    const p = stage.beginSurfacePass();
    const a = clamp(state.rpm, 0, 1) * 0.10 * alphaMul;
    if (a > 0.004) {
      const POD2 = [[-0.46, -0.60], [-0.46, 0.60], [0.52, -0.60], [0.52, 0.60]];
      for (const [x, z] of POD2) {
        mul(W, model, trs(T, x, 0.168, z, 0, 0, 0));
        stage.drawSurface(meshes.disc, W, { base: hexToLinear('#9fd6e4'), rough: 0.9, metal: 0, opacity: a, rimI: 0.0, reveal: 1 });
      }
    }
    const ap = clamp(state.pusher, 0, 1) * 0.09 * alphaMul;
    if (ap > 0.004) {
      mul(W, model, trs(T, 0.915, 0.030, 0, 0, 0, Math.PI / 2));
      stage.drawSurface(meshes.pusherDisc, W, { base: hexToLinear('#9fd6e4'), rough: 0.9, metal: 0, opacity: ap, rimI: 0.0, reveal: 1 });
    }
  }

  return { draw, drawDiscs, tick, state, meshes, MAT };
}
