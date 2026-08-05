/* FlightFoundry — procedural geometry. Everything on this site is generated in code.
   Geometry = { position:Float32Array, normal:Float32Array, uv:Float32Array, aux:Float32Array, index:Uint32Array } */

import { v3, vsub, vcross, vnorm, vlen } from './m4.js';

export class Builder {
  constructor() { this.p = []; this.n = []; this.t = []; this.a = []; this.i = []; }
  vert(x, y, z, nx = 0, ny = 1, nz = 0, u = 0, v = 0) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.t.push(u, v); this.a.push(1, 0, 0);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  build() {
    return {
      position: new Float32Array(this.p), normal: new Float32Array(this.n),
      uv: new Float32Array(this.t), aux: new Float32Array(this.a), index: new Uint32Array(this.i),
    };
  }
}

export function setAux(geo, a, b, c) {
  const n = geo.position.length / 3;
  if (!geo.aux || geo.aux.length !== n * 3) geo.aux = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { geo.aux[i * 3] = a; geo.aux[i * 3 + 1] = b; geo.aux[i * 3 + 2] = c; }
  return geo;
}

export function xform(geo, m) {
  const p = geo.position, n = geo.normal;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    p[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (n) {
      const nx = n[i], ny = n[i + 1], nz = n[i + 2];
      let rx = m[0] * nx + m[4] * ny + m[8] * nz;
      let ry = m[1] * nx + m[5] * ny + m[9] * nz;
      let rz = m[2] * nx + m[6] * ny + m[10] * nz;
      const l = Math.hypot(rx, ry, rz) || 1;
      n[i] = rx / l; n[i + 1] = ry / l; n[i + 2] = rz / l;
    }
  }
  return geo;
}

export function translate(geo, x, y, z) {
  const p = geo.position;
  for (let i = 0; i < p.length; i += 3) { p[i] += x; p[i + 1] += y; p[i + 2] += z; }
  return geo;
}
export function scaleGeo(geo, sx, sy = sx, sz = sx) {
  const p = geo.position;
  for (let i = 0; i < p.length; i += 3) { p[i] *= sx; p[i + 1] *= sy; p[i + 2] *= sz; }
  if (sx * sy * sz < 0) flip(geo);
  return geo;
}
export function flip(geo) {
  const idx = geo.index;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const n = geo.normal; for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return geo;
}

export function merge(list) {
  let vc = 0, ic = 0;
  for (const g of list) { vc += g.position.length / 3; ic += g.index.length; }
  const position = new Float32Array(vc * 3), normal = new Float32Array(vc * 3),
    uv = new Float32Array(vc * 2), aux = new Float32Array(vc * 3), index = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    position.set(g.position, vo * 3); normal.set(g.normal, vo * 3);
    if (g.uv) uv.set(g.uv, vo * 2);
    if (g.aux) aux.set(g.aux, vo * 3);
    for (let i = 0; i < g.index.length; i++) index[io + i] = g.index[i] + vo;
    vo += g.position.length / 3; io += g.index.length;
  }
  return { position, normal, uv, aux, index };
}

/* ---------------- rounded / chamfered box ---------------- */
export function roundedBox(w, h, d, r = 0.02, seg = 4) {
  const b = new Builder();
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const ix = Math.max(0, hx - r), iy = Math.max(0, hy - r), iz = Math.max(0, hz - r);
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, -1]], [[-1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [0, 1, 0], [1, 0, 0]], [[0, 0, -1], [0, 1, 0], [-1, 0, 0]],
  ];
  const N = seg;
  for (const [nrm, up, right] of faces) {
    const start = b.p.length / 3;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const u = i / N * 2 - 1, v = j / N * 2 - 1;
      /* point on the ideal box surface */
      const px = nrm[0] * hx + right[0] * u * hx + up[0] * v * hx;
      const py = nrm[1] * hy + right[1] * u * hy + up[1] * v * hy;
      const pz = nrm[2] * hz + right[2] * u * hz + up[2] * v * hz;
      const qx = Math.max(-ix, Math.min(ix, px)), qy = Math.max(-iy, Math.min(iy, py)), qz = Math.max(-iz, Math.min(iz, pz));
      let dx = px - qx, dy = py - qy, dz = pz - qz;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      b.vert(qx + dx * r, qy + dy * r, qz + dz * r, dx, dy, dz, i / N, j / N);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = start + j * (N + 1) + i;
      b.quad(a, a + 1, a + N + 2, a + N + 1);
    }
  }
  return b.build();
}

/* ---------------- cylinder / cone ---------------- */
export function cylinder(r0, r1, h, seg = 24, caps = true, thetaLen = Math.PI * 2) {
  const b = new Builder();
  const slope = (r0 - r1) / h;
  const start = b.p.length / 3;
  for (let j = 0; j <= 1; j++) {
    const r = j === 0 ? r0 : r1, y = j === 0 ? -h / 2 : h / 2;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * thetaLen, c = Math.cos(a), s = Math.sin(a);
      const nl = Math.hypot(1, slope);
      b.vert(c * r, y, s * r, c / nl, slope / nl, s / nl, i / seg, j);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = start + i, c = start + seg + 1 + i;
    b.quad(a, a + 1, c + 1, c);
  }
  if (caps) {
    for (const [r, y, ny] of [[r0, -h / 2, -1], [r1, h / 2, 1]]) {
      if (r <= 1e-6) continue;
      const ci = b.vert(0, y, 0, 0, ny, 0, 0.5, 0.5);
      const s2 = b.p.length / 3;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * thetaLen;
        b.vert(Math.cos(a) * r, y, Math.sin(a) * r, 0, ny, 0, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
      }
      for (let i = 0; i < seg; i++) {
        if (ny > 0) b.tri(ci, s2 + i, s2 + i + 1); else b.tri(ci, s2 + i + 1, s2 + i);
      }
    }
  }
  return b.build();
}

export function disc(r, seg = 32) { return cylinder(r, r, 0.0001, seg, true); }

export function torus(R, r, seg = 64, rseg = 12, arc = Math.PI * 2) {
  const b = new Builder();
  for (let j = 0; j <= seg; j++) {
    const u = (j / seg) * arc, cu = Math.cos(u), su = Math.sin(u);
    for (let i = 0; i <= rseg; i++) {
      const v = (i / rseg) * Math.PI * 2, cv = Math.cos(v), sv = Math.sin(v);
      const nx = cu * cv, ny = sv, nz = su * cv;
      b.vert(cu * (R + r * cv), r * sv, su * (R + r * cv), nx, ny, nz, j / seg, i / rseg);
    }
  }
  for (let j = 0; j < seg; j++) for (let i = 0; i < rseg; i++) {
    const a = j * (rseg + 1) + i;
    b.quad(a, a + rseg + 1, a + rseg + 2, a + 1);
  }
  return b.build();
}

export function sphere(r, seg = 24, rings = 16) {
  const b = new Builder();
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI, sp = Math.sin(phi), cp = Math.cos(phi);
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2, st = Math.sin(th), ct = Math.cos(th);
      const nx = sp * ct, ny = cp, nz = sp * st;
      b.vert(nx * r, ny * r, nz * r, nx, ny, nz, i / seg, j / rings);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i;
    b.quad(a, a + seg + 1, a + seg + 2, a + 1);
  }
  return b.build();
}

export function plane(w, d, sx = 1, sz = 1) {
  const b = new Builder();
  for (let j = 0; j <= sz; j++) for (let i = 0; i <= sx; i++) {
    b.vert((i / sx - 0.5) * w, 0, (j / sz - 0.5) * d, 0, 1, 0, i / sx, j / sz);
  }
  for (let j = 0; j < sz; j++) for (let i = 0; i < sx; i++) {
    const a = j * (sx + 1) + i;
    b.quad(a, a + sx + 1, a + sx + 2, a + 1);
  }
  return b.build();
}

/* ---------------- loft: connect a stack of rings ----------------
   sections: Array of Array of [x,y,z] (all equal length, consistent winding) */
export function loft(sections, { closedRing = true, capStart = false, capEnd = false } = {}) {
  const b = new Builder();
  const S = sections.length, R = sections[0].length;
  const idx = [];
  const tmpA = v3(), tmpB = v3(), nrm = v3();
  for (let s = 0; s < S; s++) {
    const row = [];
    for (let r = 0; r < R; r++) {
      const p = sections[s][r];
      const rp = sections[s][(r + 1) % R], rm = sections[s][(r - 1 + R) % R];
      const sp = sections[Math.min(S - 1, s + 1)][r], sm = sections[Math.max(0, s - 1)][r];
      vsub(tmpA, rp, rm); vsub(tmpB, sp, sm);
      vcross(nrm, tmpB, tmpA); vnorm(nrm, nrm);
      if (!isFinite(nrm[0]) || vlen(nrm) < 1e-6) { nrm[0] = 0; nrm[1] = 1; nrm[2] = 0; }
      row.push(b.vert(p[0], p[1], p[2], nrm[0], nrm[1], nrm[2], r / R, s / (S - 1)));
    }
    idx.push(row);
  }
  const lim = closedRing ? R : R - 1;
  for (let s = 0; s < S - 1; s++) for (let r = 0; r < lim; r++) {
    const r2 = (r + 1) % R;
    b.quad(idx[s][r], idx[s][r2], idx[s + 1][r2], idx[s + 1][r]);
  }
  const cap = (s, dir) => {
    let cx = 0, cy = 0, cz = 0;
    for (const p of sections[s]) { cx += p[0]; cy += p[1]; cz += p[2]; }
    cx /= R; cy /= R; cz /= R;
    /* plane normal from first three points */
    vsub(tmpA, sections[s][1], sections[s][0]);
    vsub(tmpB, sections[s][2], sections[s][0]);
    vcross(nrm, tmpA, tmpB); vnorm(nrm, nrm);
    if (dir < 0) { nrm[0] *= -1; nrm[1] *= -1; nrm[2] *= -1; }
    const ci = b.vert(cx, cy, cz, nrm[0], nrm[1], nrm[2], 0.5, 0.5);
    const base = b.p.length / 3;
    for (let r = 0; r < R; r++) {
      const p = sections[s][r];
      b.vert(p[0], p[1], p[2], nrm[0], nrm[1], nrm[2], 0.5, 0.5);
    }
    for (let r = 0; r < R; r++) {
      const a = base + r, c = base + ((r + 1) % R);
      if (dir > 0) b.tri(ci, a, c); else b.tri(ci, c, a);
    }
  };
  if (capStart) cap(0, -1);
  if (capEnd) cap(S - 1, 1);
  return b.build();
}

/* ---------------- NACA 4-digit airfoil ----------------
   Real airfoil mathematics — the wing sections on the aircraft are genuine NACA profiles. */
export function naca4(code = '2412', n = 40, chord = 1) {
  const m = parseInt(code[0], 10) / 100;
  const p = parseInt(code[1], 10) / 10;
  const t = parseInt(code.slice(2), 10) / 100;
  const up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const beta = (i / n) * Math.PI;
    const x = (1 - Math.cos(beta)) / 2; /* cosine spacing: dense at LE and TE */
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    let yc = 0, dyc = 0;
    if (m > 0 && p > 0) {
      if (x < p) { yc = (m / (p * p)) * (2 * p * x - x * x); dyc = (2 * m / (p * p)) * (p - x); }
      else { yc = (m / ((1 - p) ** 2)) * ((1 - 2 * p) + 2 * p * x - x * x); dyc = (2 * m / ((1 - p) ** 2)) * (p - x); }
    }
    const th = Math.atan(dyc);
    up.push([(x - yt * Math.sin(th)) * chord, (yc + yt * Math.cos(th)) * chord]);
    lo.push([(x + yt * Math.sin(th)) * chord, (yc - yt * Math.cos(th)) * chord]);
  }
  /* closed loop: TE -> upper -> LE -> lower -> TE */
  const pts = [];
  for (let i = up.length - 1; i >= 1; i--) pts.push(up[i]);
  for (let i = 0; i < lo.length - 1; i++) pts.push(lo[i]);
  return pts;
}

/* place a 2D profile into a 3D section at spanwise station */
export function airfoilSection(profile, { span, chord, twist = 0, dihedral = 0, sweepX = 0, thick = 1 }) {
  const c = Math.cos(twist), s = Math.sin(twist);
  return profile.map(([px, py]) => {
    const x0 = (px - 0.28) * chord, y0 = py * chord * thick;
    const x = x0 * c - y0 * s, y = x0 * s + y0 * c;
    return [x + sweepX, y + span * Math.tan(dihedral), span];
  });
}

/* ---------------- tube along a polyline (parallel transport) ---------------- */
export function tube(points, radiusFn, radial = 8, closed = false) {
  const N = points.length;
  const tangents = [], normals = [], binormals = [];
  const t = v3(), n = v3(), bnorm = v3();
  for (let i = 0; i < N; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(N - 1, i + 1)];
    vnorm(t, vsub(v3(), b, a));
    tangents.push(new Float32Array(t));
  }
  let up = v3(0, 1, 0);
  if (Math.abs(tangents[0][1]) > 0.9) up = v3(1, 0, 0);
  vnorm(n, vcross(v3(), up, tangents[0]));
  normals.push(new Float32Array(n));
  for (let i = 1; i < N; i++) {
    const prevN = normals[i - 1];
    const proj = v3();
    const d = tangents[i][0] * prevN[0] + tangents[i][1] * prevN[1] + tangents[i][2] * prevN[2];
    proj[0] = prevN[0] - tangents[i][0] * d; proj[1] = prevN[1] - tangents[i][1] * d; proj[2] = prevN[2] - tangents[i][2] * d;
    if (vlen(proj) < 1e-5) { proj[0] = prevN[0] + 0.001; proj[1] = prevN[1]; proj[2] = prevN[2]; }
    vnorm(proj, proj);
    normals.push(new Float32Array(proj));
  }
  for (let i = 0; i < N; i++) binormals.push(new Float32Array(vcross(v3(), tangents[i], normals[i])));
  const sections = [];
  for (let i = 0; i < N; i++) {
    const r = typeof radiusFn === 'function' ? radiusFn(i / (N - 1), i) : radiusFn;
    const ring = [];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      ring.push([
        points[i][0] + (normals[i][0] * ca + binormals[i][0] * sa) * r,
        points[i][1] + (normals[i][1] * ca + binormals[i][1] * sa) * r,
        points[i][2] + (normals[i][2] * ca + binormals[i][2] * sa) * r,
      ]);
    }
    sections.push(ring);
  }
  return loft(sections, { closedRing: true, capStart: !closed, capEnd: !closed });
}

/* ------------------------------------------------------------------
   Bake ambient occlusion into aux.x by marching a voxel occupancy grid.
   Cheap, deterministic, and it is what stops procedural hardware from
   reading as untextured plastic. ------------------------------------ */
export function bakeAO(targets, occluder, { res = 56, rays = 14, steps = 9, radius = 0.34, strength = 1 } = {}) {
  if (!Array.isArray(targets)) targets = [targets];
  if (!occluder) occluder = targets.length === 1 ? targets[0] : merge(targets);
  const p = occluder.position, idx = occluder.index;
  let minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minx) minx = p[i]; if (p[i] > maxx) maxx = p[i];
    if (p[i + 1] < miny) miny = p[i + 1]; if (p[i + 1] > maxy) maxy = p[i + 1];
    if (p[i + 2] < minz) minz = p[i + 2]; if (p[i + 2] > maxz) maxz = p[i + 2];
  }
  const pad = 0.02;
  minx -= pad; miny -= pad; minz -= pad; maxx += pad; maxy += pad; maxz += pad;
  const sx = res / (maxx - minx), sy = res / (maxy - miny), sz = res / (maxz - minz);
  const grid = new Uint8Array(res * res * res);
  const mark = (x, y, z) => {
    const gx = (x - minx) * sx | 0, gy = (y - miny) * sy | 0, gz = (z - minz) * sz | 0;
    if (gx < 0 || gy < 0 || gz < 0 || gx >= res || gy >= res || gz >= res) return;
    grid[(gz * res + gy) * res + gx] = 1;
  };
  /* rasterise each triangle by barycentric sampling at grid resolution */
  const cell = Math.min((maxx - minx) / res, (maxy - miny) / res, (maxz - minz) / res);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1 = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    const e2 = Math.hypot(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]);
    const nStep = Math.min(12, Math.max(1, Math.ceil(Math.max(e1, e2) / (cell * 0.75))));
    for (let i = 0; i <= nStep; i++) for (let j = 0; j <= nStep - i; j++) {
      const u = i / nStep, v = j / nStep, w = 1 - u - v;
      mark(p[a] * w + p[b] * u + p[c] * v, p[a + 1] * w + p[b + 1] * u + p[c + 1] * v, p[a + 2] * w + p[b + 2] * u + p[c + 2] * v);
    }
  }
  const occupied = (x, y, z) => {
    const gx = (x - minx) * sx | 0, gy = (y - miny) * sy | 0, gz = (z - minz) * sz | 0;
    if (gx < 0 || gy < 0 || gz < 0 || gx >= res || gy >= res || gz >= res) return 0;
    return grid[(gz * res + gy) * res + gx];
  };
  /* golden-spiral hemisphere directions */
  const dirs = [];
  for (let i = 0; i < rays; i++) {
    const y = 1 - (i + 0.5) / rays;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.399963229728653;
    dirs.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  /* march in voxel-sized steps and start clear of the surface's own voxel,
     otherwise every thin panel occludes itself and the whole model bakes to black */
  const cellMax = Math.max((maxx - minx) / res, (maxy - miny) / res, (maxz - minz) / res);
  const startOff = cellMax * 1.9;
  const nSteps = Math.max(3, Math.min(14, Math.ceil(radius / cellMax)));
  const step = Math.max(cellMax, radius / nSteps);
  for (const geo of targets) {
  const gp = geo.position, n = geo.normal;
  const nv = gp.length / 3;
  if (!geo.aux || geo.aux.length !== nv * 3) geo.aux = new Float32Array(nv * 3).fill(1);
  for (let i = 0; i < nv; i++) {
    const px = gp[i * 3], py = gp[i * 3 + 1], pz = gp[i * 3 + 2];
    const nx = n[i * 3], ny = n[i * 3 + 1], nz = n[i * 3 + 2];
    /* build a tangent frame around the normal */
    let ux = 0, uy = 0, uz = 0;
    if (Math.abs(ny) < 0.9) { ux = -nz; uy = 0; uz = nx; } else { ux = 1; uy = 0; uz = 0; }
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    let occ = 0;
    for (const d of dirs) {
      const dx = ux * d[0] + nx * d[1] + vx * d[2];
      const dy = uy * d[0] + ny * d[1] + vy * d[2];
      const dz = uz * d[0] + nz * d[1] + vz * d[2];
      const ox = px + nx * startOff, oy = py + ny * startOff, oz = pz + nz * startOff;
      let hit = 0;
      for (let s = 1; s <= nSteps; s++) {
        const l = s * step;
        if (occupied(ox + dx * l, oy + dy * l, oz + dz * l)) {
          hit = 1 - (s - 1) / nSteps;
          break;
        }
      }
      occ += hit;
    }
    const ao = Math.max(0, 1 - (occ / rays) * strength);
    geo.aux[i * 3] = 0.34 + 0.66 * ao;
  }
  }
  return targets;
}
