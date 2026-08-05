/* FlightFoundry — the film.
 * Scroll position is simulation time. Every act is a pure function of scroll, so scrolling
 * backwards runs the simulation backwards; nothing is triggered, everything is evaluated.
 */

import { createStage, LineSystem, PointSystem, Ribbon } from './gfx/core.js';
import { createAircraft } from './gfx/aircraft.js';
import { createWorld, TERRAIN_H } from './gfx/world.js';
import { createField, createCausal, createVault, createLoop, createSignals, STATION, COL, CAUSAL_NODES, LOOP_STAGES } from './gfx/systems.js';
import { simulate, predictFrom, lerpAt, INCIDENT, NOMINAL, STACKS, RANGE, AXES, failLimit } from './sim/flight.js';
import { buildFailureSpace } from './sim/scenarios.js';
import { Labels, Hud, buildAxes, buildLadder, buildChain, buildDelta, buildGates, buildBudget, buildFailureMeta } from './ui/hud.js';
import { m4, trs, v3, clamp, lerp, smoothstep, smootherstep, damp, easeInOut, easeOut, easeOutQuint, hexToLinear } from './lib/m4.js';
import { makeRng, fbm1 } from './lib/rand.js';

const html = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- */
/* simulation first — the copy depends on it                          */
/* ---------------------------------------------------------------- */
const RUN_FAIL = simulate(INCIDENT, STACKS.incumbent, { dt: 0.02 });
const RUN_PASS = simulate(INCIDENT, STACKS.candidate, { dt: 0.02 });
const FS = buildFailureSpace({ count: reduceMotion ? 700 : 2200 });

const EV = RUN_FAIL.events;
const CHAIN = [
  { t: EV.confDrop, text: 'Low-contrast observation — detectability below the usable floor', fail: 0 },
  { t: EV.biasExceed, text: 'Range confidence falls — corridor estimate biased by 2.2 m or more', fail: 0 },
  { t: EV.lateReplan, text: 'Planner commits to the biased estimate', fail: 0 },
  { t: EV.saturate, text: 'Lateral acceleration command exceeds available authority', fail: 0 },
  { t: EV.detect, text: 'Confidence finally rises — correction begins too late', fail: 0 },
  { t: EV.fail, text: 'Loss of separation at corridor entry', fail: 1 },
].filter((c) => c.t >= 0).sort((a, b) => a.t - b.t);

const DELTA_ROWS = [
  { label: 'Low-contrast detectability floor', a: STACKS.incumbent.detFloor.toFixed(3), b: STACKS.candidate.detFloor.toFixed(3) },
  { label: 'Minimum confidence to commit', a: 'none', b: STACKS.candidate.commitConf.toFixed(2) },
  { label: 'Replan rate', a: '1.0×', b: STACKS.candidate.replanGain.toFixed(1) + '×' },
  { label: 'Crosswind integral compensation', a: STACKS.incumbent.trackKi.toFixed(2), b: STACKS.candidate.trackKi.toFixed(2) },
  { label: 'Uncertainty corridor inflation', a: STACKS.incumbent.inflationK.toFixed(1), b: STACKS.candidate.inflationK.toFixed(1) },
];

const GATE_ROWS = [
  { label: 'Target failure — incumbent v27.4' },
  { label: 'Target failure — candidate v27.5' },
  { label: 'Regression sweep' },
  { label: 'Release gate' },
];

/* populate the data-driven copy */
const el = {
  axes: document.getElementById('axes-list'),
  ladder: document.getElementById('ladder'),
  chain: document.getElementById('chain'),
  delta: document.getElementById('delta'),
  gates: document.getElementById('gates'),
  budget: document.getElementById('budget'),
  failMeta: document.getElementById('failure-meta'),
  verdictSub: document.getElementById('verdict-sub'),
  returnTag: document.getElementById('return-tag'),
};
buildAxes(el.axes, FS);
const ladderRows = buildLadder(el.ladder, FS) || [];
const chainRows = buildChain(el.chain, CHAIN) || [];
const deltaRows = buildDelta(el.delta, DELTA_ROWS) || [];
const gateRows = buildGates(el.gates, GATE_ROWS) || [];
const budget = buildBudget(el.budget);
buildFailureMeta(el.failMeta, RUN_FAIL);
if (el.verdictSub) {
  el.verdictSub.textContent = `Same scenario, same conditions · v27.4 ${RUN_FAIL.missMargin.toFixed(2)} m → v27.5 +${RUN_PASS.missMargin.toFixed(2)} m clearance margin`;
}
if (el.returnTag) el.returnTag.textContent = `Candidate active — ${STACKS.candidate.id}`;

/* ---------------------------------------------------------------- */
/* static presentation for reduced motion / no WebGL                  */
/* ---------------------------------------------------------------- */
function goStatic(reason) {
  html.dataset.mode = 'static';
  ladderRows.forEach((r) => (r.dataset.on = '1'));
  chainRows.forEach((r) => (r.dataset.on = '1'));
  deltaRows.forEach((r) => (r.dataset.on = '1'));
  gateRows.forEach((r, i) => {
    r.dataset.on = '1';
    r.dataset.r = i === 0 ? 'fail' : 'pass';
    r.querySelector('.gate__v').textContent = i === 0 ? 'FAIL' : 'PASS';
  });
  if (budget) { budget.bar.style.setProperty('--v', '0.62'); budget.val.textContent = '62% of allowance'; }
  document.querySelectorAll('.act__hold').forEach((h) => h.style.setProperty('--rev', '1'));
  if (reason) console.info('[FlightFoundry] static presentation:', reason);
}

const canvas = document.getElementById('gl');
let stage = null;
try { stage = canvas ? createStage(canvas, { quality: 2 }) : null; } catch (e) { console.error('[FlightFoundry] renderer init failed', e); }

if (!stage || reduceMotion) {
  goStatic(!stage ? 'WebGL2 unavailable' : 'prefers-reduced-motion');
} else {
  boot();
}

/* ---------------------------------------------------------------- */
function boot() {
  const gl = stage.gl;
  const QS = new URLSearchParams(location.search);
  const isMobile = matchMedia('(max-width: 860px)').matches || innerWidth < 760;
  let quality = QS.has('q') ? +QS.get('q') : (isMobile ? 1 : 2);
  const dprCap = QS.has('dpr') ? +QS.get('dpr') : null;
  const SNAP = QS.has('snap');   /* deterministic capture: no easing, used for testing */
  stage.quality = quality;

  const aircraft = createAircraft(gl);
  const world = createWorld(gl, { quality });
  const field = createField(gl, FS, { quality });
  const causal = createCausal(gl);
  const vault = createVault(gl);
  const loop = createLoop(gl);
  const signals = createSignals(gl, RUN_FAIL.rec);
  const signalsPass = createSignals(gl, RUN_PASS.rec);

  const labels = new Labels(document.getElementById('labels'));
  const hud = new Hud(document.getElementById('hud'));
  const hudEl = document.getElementById('hud');
  const scrim = document.getElementById('scrim');
  const stagenote = document.getElementById('stagenote');
  const nav = document.getElementById('nav');

  /* dynamic ribbons */
  const flown = new Ribbon(gl, 320);
  const predicted = new Ribbon(gl, 40);
  const envA = new Ribbon(gl, 40);
  const envB = new Ribbon(gl, 40);
  const percept = new PointSystem(gl, 520);
  const sweepIn = new Ribbon(gl, 64);
  const sweepOut = new Ribbon(gl, 64);

  /* repair distribution: variations generated around the minimal counterexample */
  const repairOrigin = [2400, 30, 0];
  const repairFan = (() => {
    const rng = makeRng(5150);
    const polys = [];
    for (let i = 0; i < 200; i++) {
      const a = rng.range(0, Math.PI * 2), b = Math.acos(rng.range(-1, 1));
      const r = rng.range(28, 150);
      const dx = Math.sin(b) * Math.cos(a), dy = Math.cos(b) * 0.55, dz = Math.sin(b) * Math.sin(a);
      const K = 6;
      const p = new Float32Array((K + 1) * 3);
      for (let k = 0; k <= K; k++) {
        const u = k / K, e = easeOut(u);
        p[k * 3] = repairOrigin[0] + dx * r * e;
        p[k * 3 + 1] = repairOrigin[1] + dy * r * e;
        p[k * 3 + 2] = repairOrigin[2] + dz * r * e;
      }
      polys.push({ pts: p, meta: [i / 200, 0, rng.next()] });
    }
    return new LineSystem(gl, polys);
  })();

  /* perception return candidates on the corridor structure */
  const perceptSites = (() => {
    const rng = makeRng(771);
    const out = [];
    for (let i = 0; i < 220; i++) {
      const f = rng.next();
      const x = RANGE.gateX - RANGE.gateDepth / 2 + f * RANGE.gateDepth;
      const side = rng.next() < 0.5 ? 0 : 1;
      const z = world.gateZ[side] + rng.range(-1.2, 1.2);
      const y = rng.range(RANGE.alt - 16, RANGE.alt + 24);
      out.push([x, y, z]);
    }
    for (let i = 0; i < 60; i++) {
      out.push([RANGE.gateX - RANGE.gateDepth / 2 - 0.4 + rng.range(-0.4, 0.4), RANGE.alt + 3.4 + rng.range(-0.2, 0.2), RANGE.gapZ + rng.range(-RANGE.gapHalf, RANGE.gapHalf)]);
    }
    return out;
  })();

  /* ---------------- scroll ---------------- */
  const acts = [...document.querySelectorAll('.act')].map((node) => ({
    node, id: node.dataset.act, top: 0, height: 1,
    hold: node.querySelector('.act__hold') || node.querySelector('.wrap'),
  }));
  const actIndex = Object.fromEntries(acts.map((a, i) => [a.id, i]));
  let docH = 1;

  function measure() {
    docH = document.body.scrollHeight;
    for (const a of acts) {
      const r = a.node.getBoundingClientRect();
      a.top = r.top + scrollY;
      a.height = a.node.offsetHeight;
    }
  }

  let scrollY = window.scrollY, scrollSmooth = scrollY, scrollVel = 0;

  /* ---------------- scene state ---------------- */
  const S = {
    simF: 0, run: RUN_FAIL, frozen: 0,
    world: 0, flight: 0, signals: 0, field: 0, fieldRank: 1e9, fieldScan: -1e9, fieldDens: 0,
    causal: 0, causalPulse: -1, repair: 0, vault: 0, vaultTrace: 0, sweep: 0, channel: 0, budget: 0,
    loop: 0, loopPulse: 0, ac: 1, acReveal: 1, acCut: null, rpm: 0, pusher: 0,
    hud: 0, scrim: 1, note: 0, fogK: 0.00042, exposure: 2.9, bloom: 0.32,
    trajA: 0, trajP: 0, env: 0, percept: 0, wind: 0, windStrength: 1,
    state: 'nominal', stateLabel: 'NOMINAL', stack: STACKS.incumbent,
    instr: 0, verdict: 0, gate: [-1, -1, -1, -1], sweepPct: 0,
    side: 0, shiftX: 0, shiftY: 0,
  };

  const cam = { pos: v3(0, 0, 0), target: v3(0, 0, 0), fov: 38, stiff: 6, snap: false };
  const camGoal = { pos: v3(0, 0, 0), target: v3(0, 0, 0), fov: 38 };
  let camInit = false;

  const setPose = (px, py, pz, tx, ty, tz, fov, stiff = 5.5) => {
    camGoal.pos[0] = px; camGoal.pos[1] = py; camGoal.pos[2] = pz;
    camGoal.target[0] = tx; camGoal.target[1] = ty; camGoal.target[2] = tz;
    camGoal.fov = fov; cam.stiff = stiff;
  };
  const lerpPose = (a, b, t) => {
    const e = smootherstep(0, 1, clamp(t, 0, 1));
    setPose(
      lerp(a[0], b[0], e), lerp(a[1], b[1], e), lerp(a[2], b[2], e),
      lerp(a[3], b[3], e), lerp(a[4], b[4], e), lerp(a[5], b[5], e),
      lerp(a[6], b[6], e), a[7] !== undefined ? lerp(a[7], b[7] ?? a[7], e) : 5.5,
    );
  };

  const flightSample = (f) => lerpAt(S.run.rec, f);

  /* station exit / entry poses for the travelling shots */
  const P = {
    signalsEnd: [150, 96, 300, 150, 74, 0, 40],
    fieldIn: [STATION.field[0] - 250, STATION.field[1] + 150, 560, STATION.field[0], STATION.field[1], STATION.field[2], 44],
    fieldClose: [STATION.field[0] + 30, STATION.field[1] + 46, 285, STATION.field[0], STATION.field[1], STATION.field[2], 30],
    causalIn: [STATION.causal[0], STATION.causal[1] + 34, 168, STATION.causal[0], STATION.causal[1] + 2, STATION.causal[2], 36],
    causalClose: [STATION.causal[0] - 40, STATION.causal[1] + 14, 104, STATION.causal[0] + 16, STATION.causal[1], STATION.causal[2], 34],
    repairIn: [repairOrigin[0] - 90, repairOrigin[1] + 60, 250, repairOrigin[0], repairOrigin[1], repairOrigin[2], 40],
    vaultIn: [STATION.vault[0] - 250, STATION.vault[1] + 90, 430, STATION.vault[0], STATION.vault[1], STATION.vault[2], 38],
    vaultClose: [STATION.vault[0] - 165, STATION.vault[1] + 24, 300, STATION.vault[0] - 6, STATION.vault[1] - 6, STATION.vault[2], 35],
    vaultSweep: [STATION.vault[0] - 40, STATION.vault[1] - 60, 300, STATION.vault[0] - 4, STATION.vault[1] - 86, STATION.vault[2] + 30, 38],
    sealIn: [STATION.vault[0] + 150, STATION.vault[1] + 34, 330, STATION.vault[0] + 60, STATION.vault[1] - 4, STATION.vault[2], 36],
    loopIn: [STATION.loop[0], STATION.loop[1] + 165, 260, STATION.loop[0], STATION.loop[1], STATION.loop[2], 42],
    loopClose: [STATION.loop[0], STATION.loop[1] + 92, 190, STATION.loop[0], STATION.loop[1], STATION.loop[2], 38],
  };

  /* ---------------------------------------------------------------- */
  /* the acts                                                          */
  /* ---------------------------------------------------------------- */
  const ACTS = {
    hero(u, t) {
      S.side = -1; S.shiftX = -0.26; S.shiftY = -0.20;
      S.run = RUN_FAIL;
      S.simF = 0;
      S.world = smoothstep(0.05, 0.6, u) * 0.5;
      S.acReveal = smoothstep(0.0, 0.42, u);
      S.rpm = smoothstep(0.45, 0.95, u);
      S.pusher = smoothstep(0.72, 1.0, u) * 0.6;
      S.hud = 0; S.note = smoothstep(0.5, 0.9, u);
      S.fogK = 0.0009; S.scrim = 0.55;
      S.percept = smoothstep(0.3, 0.55, u) * (1 - smoothstep(0.6, 0.85, u));
      const s = flightSample(0);
      const az = lerp(2.66, 1.86, easeInOut(u));
      const d = lerp(7.4, 4.6, easeInOut(u));
      const ey = lerp(0.02, 0.30, easeInOut(u));
      setPose(
        s.x + Math.cos(az) * d, s.y + Math.sin(ey) * d + 0.15, s.z + Math.sin(az) * d,
        s.x + 0.05, s.y + 0.06, s.z,
        lerp(27, 31, u), 3.4,
      );
    },

    departure(u) {
      S.run = RUN_FAIL;
      S.simF = easeIn3(u) * RUN_FAIL.rec.n * 0.055;
      S.world = lerp(0.5, 1, smoothstep(0, 0.6, u));
      S.rpm = 1; S.pusher = lerp(0.6, 1, u);
      S.hud = smoothstep(0.55, 1, u);
      S.note = 1 - smoothstep(0.2, 0.6, u);
      S.fogK = lerp(0.0009, 0.00052, u);
      S.scrim = lerp(0.55, 0.8, u);
      S.instr = smoothstep(0.3, 0.8, u);
      S.trajA = smoothstep(0.5, 1, u);
      const s = flightSample(S.simF);
      const back = lerp(4.2, 6.4, easeInOut(u));
      const side = lerp(2.9, 4.0, easeInOut(u));
      const up = lerp(0.9, 2.1, easeInOut(u));
      setPose(
        s.x - back, s.y + up, s.z + side,
        s.x + lerp(1.2, 6.5, u), s.y + 0.3, s.z,
        lerp(31, 40, easeOut(u)), 3.0,
      );
    },

    flight(u) {
      S.side = -1; S.shiftX = -0.34;
      S.run = RUN_FAIL;
      S.simF = lerp(0.055, 0.44, u) * RUN_FAIL.rec.n;
      S.world = 1; S.rpm = 1; S.pusher = 1; S.hud = 1; S.instr = 1;
      S.fogK = 0.00052; S.scrim = 0.8;
      S.trajA = 1; S.trajP = smoothstep(0.05, 0.3, u); S.env = smoothstep(0.3, 0.6, u) * 0.75;
      S.wind = smoothstep(0.35, 0.7, u); S.percept = 0;
      const s = flightSample(S.simF);
      const drift = fbm1(s.t * 0.55, 2);
      setPose(
        s.x - 6.4 + drift * 0.55, s.y + 2.1 + drift * 0.3, s.z + 4.0 + drift * 0.6,
        s.x + 6.5, s.y + 0.25, s.z + 0.2,
        40, 2.6,
      );
    },

    degrade(u) {
      S.side = -1; S.shiftX = -0.34;
      S.run = RUN_FAIL;
      S.simF = lerp(0.44, 0.905, easeInOut(u)) * RUN_FAIL.rec.n;
      S.world = 1; S.rpm = 1; S.pusher = 1; S.hud = 1; S.instr = 1;
      S.fogK = lerp(0.00052, 0.00068, u);
      S.scrim = 0.8; S.trajA = 1; S.trajP = 1; S.env = lerp(0.75, 1, u);
      S.wind = 1; S.windStrength = lerp(1, 1.8, u);
      const s = flightSample(S.simF);
      S.percept = clamp(s.conf * 1.6, 0, 1);
      /* camera swings ahead so the corridor comes into frame */
      const a = easeInOut(u);
      setPose(
        s.x - lerp(6.4, 40, a), s.y + lerp(2.1, 13, a), s.z + lerp(4.0, 30, a),
        lerp(s.x + 6.5, s.x + 26, a), lerp(s.y + 0.25, s.y - 1, a), lerp(s.z + 0.2, RANGE.gapZ * 0.6, a),
        lerp(40, 33, a), 2.4,
      );
    },

    failure(u) {
      S.side = -1; S.shiftX = -0.3;
      S.run = RUN_FAIL;
      const fi = RUN_FAIL.failIndex;
      const freeze = smoothstep(0.0, 0.30, u);
      S.simF = lerp(0.905 * RUN_FAIL.rec.n, fi, easeOut(clamp(u / 0.3, 0, 1)));
      S.frozen = freeze;
      S.world = 1; S.rpm = lerp(1, 0.06, freeze); S.pusher = lerp(1, 0.04, freeze);
      S.hud = 1; S.instr = 1; S.fogK = 0.00068; S.scrim = lerp(0.8, 0.95, u);
      S.trajA = 1; S.trajP = 1 - freeze * 0.35; S.env = 1; S.wind = 1 - freeze * 0.5;
      const s = flightSample(S.simF);
      S.percept = clamp(s.conf * 1.6, 0, 1);
      /* freeze-frame orbit */
      const orbit = clamp((u - 0.28) / 0.72, 0, 1);
      const az = lerp(-2.30, -0.85, easeInOut(orbit));
      const d = lerp(48, 78, easeInOut(orbit));
      setPose(
        s.x + Math.cos(az) * d, s.y + lerp(4, 12, orbit), s.z + Math.sin(az) * d,
        s.x + 9, s.y - 1.5, s.z + 1,
        lerp(30, 27, orbit), lerp(2.4, 1.7, freeze),
      );
    },

    disassembly(u) {
      S.run = RUN_FAIL;
      S.simF = RUN_FAIL.failIndex; S.frozen = 1;
      S.rpm = 0.05; S.pusher = 0.03;
      S.world = 1 - smoothstep(0.1, 0.55, u);
      S.hud = 1 - smoothstep(0.25, 0.5, u);
      S.instr = 1;
      S.signals = smoothstep(0.18, 0.75, u);
      S.trajA = 1; S.trajP = 0.4; S.env = 1 - smoothstep(0.3, 0.7, u); S.wind = 1 - smoothstep(0.05, 0.3, u);
      S.ac = 1 - smoothstep(0.45, 0.8, u) * 0.72;
      S.fogK = lerp(0.00068, 0.00028, u);
      S.scrim = 0.9;
      const s = flightSample(S.simF);
      const a = easeInOut(clamp(u / 0.8, 0, 1));
      setPose(
        lerp(s.x + 8, 150, a), lerp(s.y + 6, 96, a), lerp(s.z + 26, 300, a),
        lerp(s.x + 3, 150, a), lerp(s.y, 74, a), lerp(s.z, 0, a),
        lerp(36, 40, a), 2.0,
      );
    },

    discover(u) {
      S.side = -1; S.shiftX = -0.3;
      S.run = RUN_FAIL; S.simF = RUN_FAIL.failIndex; S.frozen = 1;
      S.world = 0; S.hud = 0; S.ac = 1 - smoothstep(0, 0.25, u);
      S.signals = 1 - smoothstep(0.05, 0.35, u);
      S.field = smoothstep(0.18, 0.62, u);
      S.fieldDens = smoothstep(0.45, 0.9, u);
      S.fieldRank = 1e9;
      S.fogK = lerp(0.00028, 0.00058, smoothstep(0.2, 1, u));
      S.scrim = 0.85;
      /* the probability field sweeping the operating space */
      S.fieldScan = lerp(STATION.field[0] - field.scale * 1.35, STATION.field[0] + field.scale * 1.35, (u * 1.6) % 1);
      lerpPose(P.signalsEnd.concat(1.6), P.fieldIn.concat(1.6), u / 0.55);
      if (u > 0.55) {
        const k = (u - 0.55) / 0.45;
        lerpPose(P.fieldIn.concat(1.6), [P.fieldIn[0] + 180, P.fieldIn[1] - 90, 470, P.fieldIn[3], P.fieldIn[4], P.fieldIn[5], 40].concat(1.6), k);
      }
    },

    isolate(u) {
      S.side = 1; S.shiftX = 0.3;
      S.field = 1; S.ac = 0; S.signals = 0; S.world = 0; S.hud = 0;
      S.fogK = 0.00058; S.scrim = 0.85;
      S.fieldDens = 1 - smoothstep(0.1, 0.45, u);
      S.fieldScan = -1e9;
      /* the reduction ladder drives the survivor cut directly */
      const rungs = FS.rungs;
      const stageF = clamp(u / 0.86, 0, 1) * (rungs.length - 1);
      const i = Math.min(rungs.length - 2, Math.floor(stageF));
      const f = clamp(stageF - i, 0, 1);
      const a = rungs[i].n, b = rungs[i + 1].n;
      const keep = Math.max(1, Math.round(lerp(a, b, smootherstep(0, 1, f))));
      S.fieldRank = keep / FS.count;
      S.ladderStage = stageF;
      /* settle on the scenario that survives the reduction, wherever it happens to sit */
      const mi = field.order[0];
      const mx = field.centres[mi * 3], my = field.centres[mi * 3 + 1], mz = field.centres[mi * 3 + 2];
      lerpPose(
        [P.fieldIn[0] + 180, P.fieldIn[1] - 90, 470, P.fieldIn[3], P.fieldIn[4], P.fieldIn[5], 40, 1.6],
        [mx + 26, my + 34, mz + 190, mx, my, mz, 30, 1.9], easeInOut(u),
      );
    },

    diagnose(u) {
      S.side = -1; S.shiftX = -0.28;
      S.field = 1 - smoothstep(0.0, 0.32, u);
      S.fieldRank = 1 / FS.count;
      S.causal = smoothstep(0.15, 0.5, u);
      S.causalPulse = clamp((u - 0.36) / 0.6, -0.02, 1.02);
      S.fogK = 0.0006; S.scrim = 0.85; S.hud = 0;
      const mi2 = field.order[0];
      lerpPose([field.centres[mi2 * 3] + 26, field.centres[mi2 * 3 + 1] + 34, field.centres[mi2 * 3 + 2] + 190,
        field.centres[mi2 * 3], field.centres[mi2 * 3 + 1], field.centres[mi2 * 3 + 2], 30, 1.9],
        P.causalIn.concat(1.7), clamp(u / 0.42, 0, 1));
      if (u > 0.42) lerpPose(P.causalIn.concat(1.7), P.causalClose.concat(1.7), (u - 0.42) / 0.58);
    },

    repair(u) {
      S.side = 1; S.shiftX = 0.28;
      S.causal = 1 - smoothstep(0.05, 0.4, u);
      S.repair = smoothstep(0.2, 0.75, u);
      S.fogK = 0.00055; S.scrim = 0.85;
      S.deltaStage = clamp((u - 0.35) / 0.5, 0, 1);
      lerpPose(P.causalClose.concat(1.7), P.repairIn.concat(1.6), clamp(u / 0.5, 0, 1));
      if (u > 0.5) {
        const k = (u - 0.5) / 0.5;
        lerpPose(P.repairIn.concat(1.6), [repairOrigin[0] + 60, repairOrigin[1] + 20, 190, repairOrigin[0], repairOrigin[1], repairOrigin[2], 36, 1.6], k);
      }
    },

    verify(u) {
      S.side = -1; S.shiftX = -0.3;
      S.repair = 1 - smoothstep(0.0, 0.28, u);
      S.vault = smoothstep(0.12, 0.42, u);
      S.vaultTrace = smoothstep(0.3, 0.6, u) * (0.55 + 0.45 * Math.sin(u * 26));
      S.fogK = 0.00048; S.scrim = 0.85;
      /* two runs enter the protected evaluator; only their verdicts come back */
      S.enter = clamp((u - 0.34) / 0.22, 0, 1);
      S.sweep = clamp((u - 0.58) / 0.34, 0, 1);
      S.sweepPct = S.sweep;
      S.gate = [
        u > 0.47 ? 0 : -1,
        u > 0.53 ? 1 : -1,
        u > 0.62 ? (S.sweep >= 1 ? 1 : 2) : -1,
        u > 0.93 ? 1 : -1,
      ];
      lerpPose([repairOrigin[0] + 60, repairOrigin[1] + 20, 190, repairOrigin[0], repairOrigin[1], repairOrigin[2], 36, 1.6],
        P.vaultIn.concat(1.5), clamp(u / 0.34, 0, 1));
      if (u > 0.34 && u <= 0.62) lerpPose(P.vaultIn.concat(1.5), P.vaultClose.concat(1.5), (u - 0.34) / 0.28);
      if (u > 0.62) lerpPose(P.vaultClose.concat(1.5), P.vaultSweep.concat(1.5), (u - 0.62) / 0.38);
    },

    verdict(u) {
      S.side = 0; S.shiftX = 0; S.shiftY = -0.30;
      S.vault = 1; S.sweep = 1; S.sweepPct = 1;
      S.gate = [0, 1, 1, 1];
      S.verdict = smoothstep(0.1, 0.5, u);
      S.vaultTrace = 0.15;
      S.scrim = lerp(0.85, 0.96, u);
      S.bloom = lerp(0.32, 0.46, u);
      /* almost all movement stops */
      lerpPose(P.vaultSweep.concat(1.5), [STATION.vault[0] - 60, STATION.vault[1] - 20, 400, STATION.vault[0], STATION.vault[1] - 24, STATION.vault[2], 33, 0.7], u);
    },

    seal(u) {
      S.side = -1; S.shiftX = -0.30;
      S.vault = 1; S.sweep = 1 - smoothstep(0.1, 0.4, u) * 0.6;
      S.channel = smoothstep(0.2, 0.55, u);
      S.budget = clamp((u - 0.3) / 0.55, 0, 1);
      S.vaultTrace = 0.2 + 0.25 * Math.sin(u * 34);
      S.scrim = 0.92;
      lerpPose([STATION.vault[0] - 60, STATION.vault[1] - 20, 400, STATION.vault[0], STATION.vault[1] - 24, STATION.vault[2], 33, 0.7],
        P.sealIn.concat(1.2), clamp(u / 0.5, 0, 1));
    },

    loop(u) {
      S.vault = 1 - smoothstep(0.0, 0.3, u);
      S.channel = 1 - smoothstep(0.0, 0.25, u);
      S.loop = smoothstep(0.15, 0.5, u);
      S.loopPulse = u;
      S.scrim = 0.9; S.fogK = 0.00042;
      lerpPose(P.sealIn.concat(1.2), P.loopIn.concat(1.4), clamp(u / 0.5, 0, 1));
      if (u > 0.5) lerpPose(P.loopIn.concat(1.4), P.loopClose.concat(1.4), (u - 0.5) / 0.5);
    },

    platform(u) {
      S.side = 1; S.shiftX = 0.34;
      S.loop = 1; S.loopPulse = 1 + u * 0.6; S.scrim = 0.95;
      lerpPose(P.loopClose.concat(1.4), [STATION.loop[0] + 60, STATION.loop[1] + 70, 210, STATION.loop[0], STATION.loop[1], STATION.loop[2], 40, 1.0], u);
    },

    audience(u) {
      S.side = 1; S.shiftX = 0.34;
      S.loop = 1 - smoothstep(0.4, 1, u) * 0.35; S.loopPulse = 1.6 + u * 0.6; S.scrim = 0.95;
      lerpPose([STATION.loop[0] + 60, STATION.loop[1] + 70, 210, STATION.loop[0], STATION.loop[1], STATION.loop[2], 40, 1.0],
        [STATION.loop[0] - 80, STATION.loop[1] + 40, 240, STATION.loop[0], STATION.loop[1], STATION.loop[2], 42, 1.0], u);
    },

    return(u) {
      S.side = -1; S.shiftX = -0.3;
      S.run = RUN_PASS; S.stack = STACKS.candidate;
      S.loop = 1 - smoothstep(0, 0.25, u);
      S.frozen = 0;
      const start = 0.30, end = 0.985;
      S.simF = lerp(start, end, easeInOut(clamp((u - 0.22) / 0.78, 0, 1))) * RUN_PASS.rec.n;
      S.world = smoothstep(0.06, 0.3, u);
      S.ac = smoothstep(0.08, 0.3, u);
      S.acReveal = 1; S.rpm = 1; S.pusher = 1;
      S.hud = smoothstep(0.15, 0.35, u);
      S.trajA = 1; S.trajP = 1; S.env = 0.5; S.wind = 1; S.windStrength = 1.8;
      S.fogK = lerp(0.00042, 0.00058, smoothstep(0, 0.35, u));
      S.scrim = 0.85; S.instr = 1;
      const s = flightSample(S.simF);
      S.percept = clamp(s.conf * 1.4, 0, 1);
      const a = clamp(u / 0.22, 0, 1);
      const camA = [STATION.loop[0] - 80, STATION.loop[1] + 40, 240, STATION.loop[0], STATION.loop[1], STATION.loop[2], 42, 1.0];
      const camB = [s.x - 15, s.y + 3.2, s.z + 11.5, RANGE.gateX, RANGE.alt, RANGE.gapZ, 38, 2.2];
      if (u < 0.22) lerpPose(camA, camB, a);
      else {
        const k = (u - 0.22) / 0.78;
        setPose(
          s.x - lerp(15, 18, k), s.y + lerp(3.2, 4.0, k), s.z + lerp(11.5, 13.5, k),
          lerp(RANGE.gateX, s.x + 20, smoothstep(0.4, 0.9, k)), lerp(RANGE.alt, s.y + 0.2, smoothstep(0.4, 0.9, k)), lerp(RANGE.gapZ, s.z, smoothstep(0.4, 0.9, k)),
          lerp(38, 42, k), 2.3,
        );
      }
    },

    cta(u) {
      S.run = RUN_PASS; S.stack = STACKS.candidate;
      S.simF = RUN_PASS.rec.n - 1;
      S.world = 1 - smoothstep(0.05, 0.7, u);
      S.ac = 1 - smoothstep(0.55, 0.95, u);
      S.rpm = 1; S.pusher = 1; S.hud = 1 - smoothstep(0, 0.25, u);
      S.trajA = 1 - smoothstep(0.2, 0.6, u); S.trajP = 0; S.env = 0;
      S.wind = 1 - smoothstep(0.1, 0.5, u);
      S.fogK = lerp(0.00058, 0.00026, u);
      S.scrim = lerp(0.85, 1, u); S.instr = 1 - smoothstep(0.3, 0.6, u);
      S.state = 'verified'; S.stateLabel = 'VERIFIED';
      const s = flightSample(S.simF);
      const k = easeInOut(u);
      setPose(
        s.x - lerp(15, 62, k), s.y + lerp(3.4, 12, k), s.z + lerp(9, 26, k),
        s.x + lerp(30, 120, k), s.y + 0.4, s.z,
        lerp(46, 38, k), 1.5,
      );
    },
  };

  function easeIn3(t) { return t * t * t; }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */
  let last = performance.now(), frameAvg = 16, low = 0, camShiftX = 0, camShiftY = 0, isNarrow = false;
  let W = 0, H = 0, DPR = 1;

  function resize() {
    W = innerWidth; H = innerHeight; isNarrow = W < 900;
    DPR = dprCap !== null ? dprCap : Math.min(window.devicePixelRatio || 1, quality > 1 ? 1.75 : 1.25);
    stage.resize(W, H, DPR);
    measure();
  }
  addEventListener('resize', resize, { passive: true });
  addEventListener('scroll', () => { scrollY = window.scrollY; }, { passive: true });
  resize();

  const M = m4(), I = trs(m4(), 0, 0, 0, 0, 0, 0);
  const tmp = v3();
  const SCRATCH_A = new Float32Array(300 * 3);
  const SCRATCH_EA = new Float32Array(34 * 3), SCRATCH_EB = new Float32Array(34 * 3);

  function frame(now) {
    const dtRaw = Math.min(0.05, (now - last) / 1000);
    last = now;
    frameAvg = frameAvg * 0.92 + dtRaw * 1000 * 0.08;
    stage.time += dtRaw;

    /* adaptive quality */
    if (!QS.has('q') && frameAvg > 27 && quality > 0) { low++; if (low > 90) { quality--; stage.quality = quality; low = 0; resize(); } }
    else if (frameAvg < 15 && low > 0) low--;

    /* smoothed scroll: gives camera moves mass */
    const prev = scrollSmooth;
    scrollSmooth = SNAP ? scrollY : damp(scrollSmooth, scrollY, 7.5, dtRaw);
    scrollVel = (scrollSmooth - prev) / Math.max(1e-4, dtRaw);

    /* defaults each frame */
    S.world = 0; S.signals = 0; S.field = 0; S.causal = 0; S.repair = 0; S.vault = 0;
    S.loop = 0; S.ac = 1; S.hud = 0; S.instr = 0; S.trajA = 0; S.trajP = 0; S.env = 0;
    S.wind = 0; S.percept = 0; S.channel = 0; S.sweep = 0; S.verdict = 0; S.fieldDens = 0;
    S.frozen = 0; S.acReveal = 1; S.stack = STACKS.incumbent; S.state = 'nominal'; S.stateLabel = 'NOMINAL';
    S.gate = [-1, -1, -1, -1]; S.fieldRank = 1e9; S.fieldScan = -1e9; S.windStrength = 1;
    S.budget = 0; S.ladderStage = -1; S.deltaStage = 0; S.causalPulse = -1; S.bloom = 0.32;
    S.side = 0; S.shiftX = 0; S.shiftY = 0;

    /* which act, and how far through it */
    let activeIdx = 0;
    for (let i = 0; i < acts.length; i++) {
      if (scrollSmooth + 1 >= acts[i].top) activeIdx = i;
    }
    const A = acts[activeIdx];
    const span = Math.max(1, A.node.classList.contains('act--doc') ? A.height : A.height);
    let u = clamp((scrollSmooth - A.top) / span, 0, 1);
    const fn = ACTS[A.id];
    if (fn) fn(u, stage.time);

    /* reveal for the copy of the active act (and neighbours near the seam) */
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      const holdEl = a.hold;
      if (!holdEl) continue;
      let rv = 0;
      if (i === activeIdx) rv = smoothstep(0.015, 0.13, u) * (1 - smoothstep(a.id === 'cta' ? 0.62 : 0.88, a.id === 'cta' ? 0.82 : 1.0, u));
      else if (i === activeIdx + 1) rv = 0;
      if (a.rv !== rv) { holdEl.style.setProperty('--rev', rv.toFixed(3)); a.rv = rv; }
      const live = rv > 0.01 ? '1' : '0';
      if (holdEl.dataset.live !== live) holdEl.dataset.live = live;
    }

    updateWidgets(A.id, u);

    /* camera integration */
    if (!camInit || SNAP) { cam.pos.set(camGoal.pos); cam.target.set(camGoal.target); cam.fov = camGoal.fov; camInit = true; }
    const k = 1 - Math.exp(-cam.stiff * dtRaw);
    for (let i = 0; i < 3; i++) {
      cam.pos[i] += (camGoal.pos[i] - cam.pos[i]) * k;
      cam.target[i] += (camGoal.target[i] - cam.target[i]) * k;
    }
    cam.fov += (camGoal.fov - cam.fov) * k;
    stage.cam.pos.set(cam.pos); stage.cam.target.set(cam.target); stage.cam.fov = cam.fov;
    camShiftX = SNAP ? (isNarrow ? 0 : S.shiftX) : damp(camShiftX, isNarrow ? 0 : S.shiftX, 3.2, dtRaw);
    camShiftY = SNAP ? (isNarrow ? 0 : S.shiftY) : damp(camShiftY, isNarrow ? 0 : S.shiftY, 3.2, dtRaw);
    stage.cam.shift[0] = camShiftX; stage.cam.shift[1] = camShiftY;
    stage.cam.near = 0.35; stage.cam.far = 6000;
    stage.updateCamera();

    stage.fog.k = SNAP ? S.fogK : damp(stage.fog.k, S.fogK, 4, dtRaw);
    stage.grade.bloom = SNAP ? S.bloom : damp(stage.grade.bloom, S.bloom, 4, dtRaw);

    render(dtRaw);
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------- */
  function render(dt) {
    const rec = S.run.rec;
    const s = lerpAt(rec, S.simF);
    const params = S.run.params;

    /* --- ribbons --- */
    if (S.trajA > 0.001) {
      const n = Math.min(300, Math.max(2, Math.floor(S.simF / 4)));
      const pts = SCRATCH_A;
      for (let i = 0; i < n; i++) {
        const f = (i / (n - 1)) * S.simF;
        const q = lerpAt(rec, f);
        pts[i * 3] = q.x; pts[i * 3 + 1] = q.y; pts[i * 3 + 2] = q.z;
      }
      flown.set(pts, n, [0, 0, 0]);
    }
    if (S.trajP > 0.001 || S.env > 0.001) {
      const pr = predictFrom(rec, Math.round(clamp(S.simF, 0, rec.n - 1)), S.stack, params, 2.8, 34);
      predicted.set(pr, 34, [0, 0, 0]);
      const sig = Math.sqrt(Math.max(0, s.P)) * 0.55;
      const eA = SCRATCH_EA, eB = SCRATCH_EB;
      for (let i = 0; i < 34; i++) {
        const g = (i / 33);
        const w = sig * (0.35 + 0.85 * g);
        eA[i * 3] = pr[i * 3]; eA[i * 3 + 1] = pr[i * 3 + 1]; eA[i * 3 + 2] = pr[i * 3 + 2] + w;
        eB[i * 3] = pr[i * 3]; eB[i * 3 + 1] = pr[i * 3 + 1]; eB[i * 3 + 2] = pr[i * 3 + 2] - w;
      }
      envA.set(eA, 34, [0, 0, 0]); envB.set(eB, 34, [0, 0, 0]);
    }

    /* --- perception returns --- */
    if (S.percept > 0.002) {
      let c = 0;
      const heroSweep = S.world < 0.6;
      if (heroSweep) {
        /* hero: the sensor sweeps the volume around the aircraft */
        /* a single scanning fan leaving the nose turret, sweeping in azimuth */
        const sweepA = Math.sin(stage.time * 0.55) * 0.95;
        const RAYS = 5, SAMPLES = 22;
        for (let r0 = 0; r0 < RAYS; r0++) {
          const elev = (r0 / (RAYS - 1) - 0.5) * 0.30;
          const az = sweepA + (r0 - (RAYS - 1) / 2) * 0.012;
          for (let k = 0; k < SAMPLES; k++) {
            const d = 1.1 + (k / SAMPLES) * 7.5;
            const fade = 1 - k / SAMPLES;
            percept.P[c * 3] = s.x - 0.36 - Math.cos(az) * d;
            percept.P[c * 3 + 1] = s.y - 0.08 - Math.sin(elev) * d - 0.10 * d;
            percept.P[c * 3 + 2] = s.z + Math.sin(az) * d;
            percept.M[c * 3] = 1.2 + fade * 1.6;
            percept.M[c * 3 + 1] = 0;
            percept.M[c * 3 + 2] = 0;
            c++;
          }
        }
      } else {
        const maxN = Math.round(14 + S.percept * 74);
        for (let i = 0; i < perceptSites.length && c < maxN; i++) {
          const p = perceptSites[i];
          const d = Math.abs(p[0] - s.x);
          if (d > 110 || d < 4) continue;
          /* returns flicker: a detection is an event, not a permanent decoration */
          const flick = 0.55 + 0.45 * Math.sin(stage.time * 3.1 + i * 2.7);
          const seen = clamp(S.percept * (1.2 - d / 110) * flick, 0, 1);
          if (seen < 0.16) continue;
          percept.P[c * 3] = p[0]; percept.P[c * 3 + 1] = p[1]; percept.P[c * 3 + 2] = p[2];
          percept.M[c * 3] = 1.6 + seen * 2.2;
          percept.M[c * 3 + 1] = 0;
          percept.M[c * 3 + 2] = 0;
          c++;
        }
      }
      percept.sync(c);
    }

    if (S.wind > 0.002) world.updateWind(stage.time, S.windStrength, s.x);

    /* --- aircraft state --- */
    const rollCmd = S.frozen > 0.5 ? s.roll : s.roll;
    aircraft.tick(dt * (1 - S.frozen * 0.97), {
      rpm: S.rpm, pusher: S.pusher, aileron: clamp(-s.roll * 0.55, -0.32, 0.32),
      gimbal: Math.sin(stage.time * 0.5) * 0.12 + clamp(s.zHat - s.z, -6, 6) * 0.03,
      reveal: S.acReveal, opacity: 1,
    });

    /* ================= draw ================= */
    stage.clear(0, 0, 0);

    /* solids */
    if (S.world > 0.002) world.drawSolids(stage, { opacity: S.world, reveal: 1 });
    if (S.ac > 0.002) {
      const yaw = Math.atan2(s.vz, params.speed);
      trs(M, s.x, s.y, s.z, s.roll, yaw, -s.pitch);
      aircraft.draw(stage, M, { reveal: S.acReveal, opacity: S.ac });
    }
    if (S.causal > 0.002) {
      const p = stage.beginSurfacePass();
      for (let i = 0; i < causal.nodes.length; i++) {
        const nd = causal.nodes[i];
        const on = S.causalPulse >= 0 ? clamp((S.causalPulse * causal.nodes.length) - i, 0, 1) : 0;
        trs(M, nd.p[0], nd.p[1], nd.p[2], 0, 0, 0);
        stage.drawSurface(causal.plateMesh, M, {
          base: hexToLinear('#151a1f'), rough: 0.42, metal: 0.25, opacity: S.causal,
          rimCol: i === causal.nodes.length - 1 ? COL.fail : COL.sig, rimI: 0.06 + on * 0.5,
          emis: i === causal.nodes.length - 1 ? COL.fail : COL.sig, emisI: on * 0.06,
        });
      }
    }
    if (S.vault > 0.002) {
      const p = stage.beginSurfacePass();
      stage.drawSurface(vault.mesh, I, {
        base: hexToLinear('#161b21'), rough: 0.62, metal: 0.12, opacity: S.vault,
        rimCol: COL.sig, rimI: 0.045, ao: 1,
      });
    }
    if (S.loop > 0.002) {
      const p = stage.beginSurfacePass();
      for (const st of loop.stations) {
        const d = Math.abs(((S.loopPulse % 1) + 1) % 1 - st.t);
        const near = 1 - smoothstep(0, 0.09, Math.min(d, 1 - d));
        trs(M, st.p[0], st.p[1], st.p[2], 0, 0, Math.PI * 0.25);
        stage.drawSurface(loop.markerMesh, M, {
          base: hexToLinear('#12171c'), rough: 0.4, metal: 0.3, opacity: S.loop,
          rimCol: COL.sig, rimI: 0.08 + near * 0.7, emis: COL.sig, emisI: near * 0.10,
        });
      }
    }

    /* additive layers */
    stage.additive();
    const L = stage.beginLinePass();
    const px = (n) => (n * DPR) / stage.h;
    /* additive layers are scaled against the scene exposure so nothing clips to white */
    const setA = (v) => L.set('uAlpha', v * 0.40);

    if (S.world > 0.002) {
      L.set('uWidth', px(1.0)); setA(0.10 * S.world);
      L.set('uColA', COL.dim); L.set('uColB', COL.dim);
      L.set('uRankCut', 0.55); L.set('uRankSoft', 0.4);
      world.contourSys.draw(L);
      L.set('uRankCut', 1e9);
    }
    if (S.wind > 0.002) {
      L.set('uWidth', px(1.0)); setA(0.09 * S.wind * clamp(S.windStrength, 0.6, 2));
      L.set('uColA', COL.sig); L.set('uColB', COL.sig);
      L.set('uRankCut', 0.55); L.set('uRankSoft', 0.5);
      world.wind.draw(L);
      L.set('uRankCut', 1e9);
    }
    if (S.trajA > 0.002) {
      L.set('uWidth', px(1.5)); setA(0.55 * S.trajA);
      L.set('uColA', COL.pass); L.set('uColB', COL.pass);
      L.set('uWindow', [-0.01, 1.01]); L.set('uDash', 0);
      flown.draw(L);
    }
    if (S.trajP > 0.002) {
      L.set('uWidth', px(1.4)); setA(0.8 * S.trajP);
      L.set('uColA', COL.sig); L.set('uColB', COL.sig);
      L.set('uDash', 16); L.set('uDashPhase', -stage.time * 0.35);
      predicted.draw(L);
      L.set('uDash', 0);
    }
    if (S.env > 0.002) {
      L.set('uWidth', px(1.0)); setA(0.30 * S.env);
      const wide = clamp(Math.sqrt(Math.max(0, s.P)) / 6, 0, 1);
      L.set('uColA', COL.sig); L.set('uColB', COL.warn);
      L.set('uWindow', [-0.01, 1.01]);
      const p2 = stage.progs.line;
      p2.set('uColA', wide > 0.55 ? COL.warn : COL.sig);
      envA.draw(L); envB.draw(L);
    }
    if (S.signals > 0.002) {
      L.set('uWidth', px(1.5)); setA(1.5 * S.signals);
      L.set('uColA', COL.sig); L.set('uColB', COL.fail);
      L.set('uWindow', [-0.01, lerp(0.05, 1.01, smoothstep(0.1, 0.85, S.signals))]);
      signals.sys.draw(L);
      L.set('uWindow', [-0.01, 1.01]);
    }
    if (S.field > 0.002) {
      L.set('uWidth', px(1.15)); setA(0.5 * S.field);
      L.set('uColA', COL.pass); L.set('uColB', COL.fail);
      L.set('uRankCut', S.fieldRank); L.set('uRankSoft', 0.06);
      L.set('uWindow', [-0.01, lerp(0.02, 1.01, smoothstep(0, 0.7, S.field))]);
      if (S.fieldScan > -1e8) { L.set('uScan', S.fieldScan); L.set('uScanW', 46); L.set('uScanCol', COL.sig); }
      field.lines.draw(L);
      L.set('uScanW', 0); L.set('uRankCut', 1e9); L.set('uWindow', [-0.01, 1.01]);
    }
    if (S.causal > 0.002) {
      L.set('uWidth', px(1.4)); setA(0.55 * S.causal);
      L.set('uColA', COL.sig); L.set('uColB', COL.sig);
      causal.edges.draw(L);
      if (S.causalPulse >= 0) {
        const pw = 0.16;
        const c = clamp(S.causalPulse, 0, 1);
        setA(1.0 * S.causal);
        L.set('uColA', COL.warn); L.set('uColB', COL.warn);
        L.set('uRankCut', c + 0.001); L.set('uRankSoft', 0.001);
        L.set('uWindow', [Math.max(0, (c * causal.nodes.length % 1) - pw), (c * causal.nodes.length % 1) + pw]);
        causal.edges.draw(L);
        L.set('uRankCut', 1e9); L.set('uWindow', [-0.01, 1.01]);
      }
    }
    if (S.repair > 0.002) {
      L.set('uWidth', px(1.05)); setA(0.42 * S.repair);
      L.set('uColA', COL.sig); L.set('uColB', COL.sig);
      L.set('uWindow', [-0.01, lerp(0.02, 1.01, S.repair)]);
      L.set('uRankCut', S.repair); L.set('uRankSoft', 0.25);
      repairFan.draw(L);
      L.set('uRankCut', 1e9); L.set('uWindow', [-0.01, 1.01]);
    }
    if (S.vault > 0.002 && S.vaultTrace > 0.002) {
      L.set('uWidth', px(1.0)); setA(0.10 * clamp(S.vaultTrace, 0, 1) * S.vault);
      L.set('uColA', COL.sig); L.set('uColB', COL.sig);
      vault.traces.draw(L);
    }
    if (S.channel > 0.002) {
      L.set('uWidth', px(1.3)); setA(0.7 * S.channel);
      L.set('uColA', COL.warn); L.set('uColB', COL.warn);
      L.set('uDash', 22); L.set('uDashPhase', -stage.time * 0.5);
      vault.channel.draw(L);
      L.set('uDash', 0);
    }
    if (S.loop > 0.002) {
      L.set('uWidth', px(1.2)); setA(0.32 * S.loop);
      L.set('uColA', COL.sig); L.set('uColB', COL.sig);
      loop.ring.draw(L);
      /* one bright information pulse, always travelling */
      const c = ((S.loopPulse * 0.85) % 1 + 1) % 1;
      setA(1.0 * S.loop); L.set('uWidth', px(2.2));
      L.set('uWindow', [c - 0.035, c + 0.035]);
      loop.ring.draw(L);
      L.set('uWindow', [-0.01, 1.01]);
    }

    /* points */
    const PP = stage.beginPointPass();
    const setP = (v) => PP.set('uAlpha', v * 0.44);
    if (S.world > 0.002) {
      PP.set('uWorld', 1); PP.set('uSizeClamp', [0.5, 7]);
      PP.set('uColA', COL.dim); PP.set('uColB', COL.dim);
      setP(0.22 * S.world); PP.set('uSquare', 1);
      world.ground.draw(PP);
    }
    if (S.percept > 0.002) {
      PP.set('uWorld', 0); PP.set('uSizeClamp', [1, 14]);
      PP.set('uColA', COL.sig); PP.set('uColB', COL.sig);
      setP(0.42 * S.percept); PP.set('uSquare', 1);
      percept.draw(PP);
    }
    if (S.fieldDens > 0.002) {
      PP.set('uWorld', 1); PP.set('uSizeClamp', [2, 90]);
      PP.set('uColA', COL.fail); PP.set('uColB', COL.fail);
      setP(0.05 * S.fieldDens); PP.set('uSquare', 0);
      field.dens.draw(PP);
    }
    if (S.sweep > 0.002) {
      /* regression results accumulate as they complete */
      const n = Math.floor(S.sweep * vault.RES);
      for (let i = 0; i < vault.RES; i++) vault.results.M[i * 3 + 1] = i < n ? (i % 97 === 13 ? 1 : 0) : 0;
      vault.results.mesh.update('aMeta', vault.results.M, vault.results.count * 3);
      PP.set('uWorld', 0); PP.set('uSizeClamp', [1, 12]);
      PP.set('uColA', COL.ok); PP.set('uColB', COL.warn);
      setP(0.62); PP.set('uSquare', 1);
      const saved = vault.results.count;
      vault.results.count = Math.max(1, n);
      vault.results.draw(PP);
      vault.results.count = saved;
    }
    if (S.rpm > 0.02 && S.ac > 0.002) {
      const yaw = Math.atan2(s.vz, params.speed);
      trs(M, s.x, s.y, s.z, s.roll, yaw, -s.pitch);
      aircraft.drawDiscs(stage, M, S.ac);
    }
    stage.opaque();
    stage.post();

    updateOverlay(s, dt);
  }

  /* ---------------------------------------------------------------- */
  function updateOverlay(s, dt) {
    hudEl.style.setProperty('--hud', S.hud.toFixed(3));
    scrim.style.setProperty('--scrim', S.scrim.toFixed(3));
    scrim.style.setProperty('--side-l', S.side < 0 ? '1' : '0');
    scrim.style.setProperty('--side-r', S.side > 0 ? '1' : '0');
    if (stagenote) stagenote.style.setProperty('--note', S.note ? String(S.note) : '0');
    nav.classList.toggle('is-instr', S.instr > 0.5);

    /* state colour is derived from the simulation, never decorative */
    let state = 'nominal', label = 'NOMINAL';
    if (S.stack === STACKS.candidate && S.simF > S.run.rec.n * 0.9) { state = 'verified'; label = 'VERIFIED'; }
    else if (S.frozen > 0.4) { state = 'failed'; label = 'FAILED'; }
    else if (s.conf < 0.25 && s.range < 120 && s.range > 0) { state = 'degraded'; label = 'DEGRADED'; }
    else if (s.effort > 0.85) { state = 'degraded'; label = 'HIGH EFFORT'; }
    hud.setState(state, label);
    hud.setSim(S.stack === STACKS.candidate ? 'SIM 01 · REPLAY · v27.5' : 'SIM 01 · TEST RANGE 04');
    hud.setTime(s.t);
    hud.update({
      y: s.y, vel: S.run.params.speed, windSpeed: Math.abs(s.wind) / 0.11,
      conf: s.conf, P: s.P, effort: s.effort, range: s.range,
      planLabel: s.range <= 0 ? 'CLEAR' : (s.conf >= (S.stack.commitConf || 0) ? 'TRACKING' : 'HOLDING PRIOR'),
      planLevel: s.range > 0 && s.conf < (S.stack.commitConf || 0) && s.range < 90 ? 'warn' : '',
    }, dt, S.stack);

    /* projected labels */
    labels.hideAll();
    if (S.world > 0.5 && S.field < 0.1) {
      labels.set('gate', [RANGE.gateX, RANGE.alt + 12, RANGE.gapZ], S.world > 0.6 ? 1 : 0,
        { text: 'INSPECTION CORRIDOR', sub: `GAP ${(RANGE.gapHalf * 2).toFixed(1)} m`, cls: 'sig', tick: true });
    }
    if (S.trajP > 0.4) {
      const pr = predictFrom(S.run.rec, Math.round(clamp(S.simF, 0, S.run.rec.n - 1)), S.stack, S.run.params, 2.8, 34);
      labels.set('pred', [pr[33 * 3], pr[33 * 3 + 1] + 1.4, pr[33 * 3 + 2]], 1, { text: 'PREDICTED', cls: 'sig', tick: true });
    }
    if (S.trajA > 0.5 && S.signals < 0.2) {
      labels.set('flown', [s.x - 22, s.y - 1.6, s.z], S.world > 0.5 ? 1 : 0, { text: 'FLOWN', tick: true });
    }
    if (S.frozen > 0.5 && S.signals < 0.3) {
      labels.set('fail', [s.x + 1, s.y + 2.2, s.z], 1, { text: 'LOSS OF SEPARATION', sub: `${S.run.missMargin.toFixed(2)} m`, cls: 'fail', tick: true });
    }
    if (S.signals > 0.3) {
      for (let i = 0; i < signals.lanes.length; i++) {
        const ln = signals.lanes[i];
        labels.set('lane' + i, [RUN_FAIL.rec.x[0] - 6, ln.y, 0], 1, { text: ln.label, cls: ln.flag ? 'fail' : 'sig', tick: true });
      }
      labels.set('tfail', [RUN_FAIL.rec.x[RUN_FAIL.failIndex], 132, 0], 1, { text: 'FAILURE', sub: `T+${RUN_FAIL.events.fail.toFixed(2)} s`, cls: 'fail', tick: true });
    }
    if (S.field > 0.35) {
      const pr = FS.embed.primary;
      const sc = field.scale;
      const O = STATION.field;
      const ax = (k) => AXES.find((a) => a.key === k).label;
      labels.set('ax0', [O[0] + sc * 1.15, O[1], O[2]], 1, { text: ax(pr[0]), cls: 'sig', tick: true });
      labels.set('ax1', [O[0], O[1] + sc * 0.72, O[2]], 1, { text: ax(pr[1]), cls: 'sig', tick: true });
      labels.set('ax2', [O[0], O[1], O[2] + sc * 1.15], 1, { text: ax(pr[2]), cls: 'sig', tick: true });
      if (S.fieldRank < 0.02) {
        const idx = field.order[0];
        labels.set('mincx', [field.centres[idx * 3], field.centres[idx * 3 + 1] + 8, field.centres[idx * 3 + 2]], 1,
          { text: 'MINIMAL COUNTEREXAMPLE', sub: FS.reduction.essential.map((k) => ax(k)).join(' · '), cls: 'fail', tick: true });
      }
    }
    if (S.causal > 0.35) {
      for (let i = 0; i < causal.nodes.length; i++) {
        const nd = causal.nodes[i];
        const on = S.causalPulse >= 0 ? clamp((S.causalPulse * causal.nodes.length) - i, 0, 1) : 0;
        labels.set('cn' + i, [nd.p[0], nd.p[1] + 9, nd.p[2]], 1,
          { text: nd.label, sub: on > 0.4 ? nd.sub : '', cls: i === causal.nodes.length - 1 ? 'fail' : (on > 0.4 ? 'warn' : 'sig'), tick: false });
      }
    }
    if (S.repair > 0.35) {
      labels.set('rep', [repairOrigin[0], repairOrigin[1] + 90, repairOrigin[2]], 1,
        { text: 'CORRECTIVE DISTRIBUTION', sub: 'variations around the counterexample', cls: 'sig', tick: true });
    }
    if (S.vault > 0.3) {
      labels.set('vault', [STATION.vault[0], STATION.vault[1] + vault.H * 0.5 + 34, STATION.vault[2]], 1,
        { text: 'PROTECTED EVALUATION', sub: 'scenarios the repair process cannot see', cls: 'sig', tick: false });
      if (S.gate[0] === 0) labels.set('vi', [STATION.vault[0] - vault.R - 26, STATION.vault[1] + 16, STATION.vault[2] + 40], 1, { text: 'v27.4 · FAIL', cls: 'fail', tick: true });
      if (S.gate[1] === 1) labels.set('vc', [STATION.vault[0] - vault.R - 26, STATION.vault[1] - 6, STATION.vault[2] + 40], 1, { text: 'v27.5 · PASS', cls: 'pass', tick: true });
      if (S.sweep > 0.02) labels.set('vs', [STATION.vault[0] - 96, STATION.vault[1] - vault.H * 0.5 - 30, STATION.vault[2] + 74], 1,
        { text: 'REGRESSION SWEEP', sub: `${Math.floor(S.sweep * vault.RES)} / ${vault.RES}`, cls: S.sweep >= 1 ? 'pass' : 'warn', tick: true });
    }
    if (S.channel > 0.3) {
      labels.set('chan', [STATION.vault[0] + vault.R + 110, STATION.vault[1] + 12, STATION.vault[2]], 1,
        { text: 'CONSTRAINED FEEDBACK', sub: 'the only thing allowed out', cls: 'warn', tick: true });
    }
    if (S.loop > 0.35) {
      for (const st of loop.stations) {
        const d = Math.abs(((S.loopPulse * 0.85 % 1) + 1) % 1 - st.t);
        const near = 1 - smoothstep(0, 0.10, Math.min(d, 1 - d));
        labels.set('ls' + st.label, [st.p[0], st.p[1] + 13, st.p[2]], 1, { text: st.label, cls: near > 0.4 ? 'sig' : '', tick: false });
      }
    }
    labels.render(stage.cam.viewProj, W, H, dt);
  }

  /* ---------------------------------------------------------------- */
  function updateWidgets(actId, u) {
    if (S.ladderStage >= 0) {
      for (let i = 0; i < ladderRows.length; i++) {
        ladderRows[i].dataset.on = i <= Math.floor(S.ladderStage + 0.15) ? '1' : '0';
      }
    } else if (actId !== 'isolate') {
      for (const r of ladderRows) r.dataset.on = actId === 'diagnose' ? '1' : '0';
    }
    if (actId === 'diagnose') {
      const c = clamp(S.causalPulse, 0, 1);
      for (let i = 0; i < chainRows.length; i++) chainRows[i].dataset.on = (c * chainRows.length) > i + 0.25 ? '1' : '0';
    } else if (actId !== 'diagnose') {
      for (const r of chainRows) r.dataset.on = '0';
    }
    for (let i = 0; i < deltaRows.length; i++) {
      deltaRows[i].dataset.on = (S.deltaStage * deltaRows.length) > i ? '1' : '0';
    }
    for (let i = 0; i < gateRows.length; i++) {
      const g = S.gate[i];
      gateRows[i].dataset.on = g >= 0 ? '1' : '0';
      const v = gateRows[i].querySelector('.gate__v');
      if (g === 1) { gateRows[i].dataset.r = 'pass'; v.textContent = i === 2 ? `PASS · ${vault.RES}` : 'PASS'; }
      else if (g === 0) { gateRows[i].dataset.r = 'fail'; v.textContent = 'FAIL'; }
      else if (g === 2) { gateRows[i].dataset.r = 'run'; v.textContent = `${Math.floor(S.sweepPct * vault.RES)} / ${vault.RES}`; }
      else { gateRows[i].dataset.r = 'idle'; v.textContent = '—'; }
    }
    if (budget) {
      budget.bar.style.setProperty('--v', S.budget.toFixed(3));
      budget.val.textContent = S.budget < 0.02 ? 'sealed' : `${Math.round(S.budget * 74)}% of allowance`;
    }
  }

  if (QS.has('debug')) {
    window.__ff = { S, stage, cam, camGoal, acts, aircraft, world, field, vault, loop,
      sample: () => lerpAt(S.run.rec, S.simF) };
  }
  requestAnimationFrame((t) => { last = t; measure(); frame(t); });
  addEventListener('load', measure);
  setTimeout(measure, 400);
}
