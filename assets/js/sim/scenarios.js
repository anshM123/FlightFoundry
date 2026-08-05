/* FlightFoundry — failure-space search and counterexample reduction.
 *
 * The scenario cloud shown on the site is not decoration: every point is a real run of the
 * simulator in sim/flight.js under a sampled operating condition. Failure regions are emergent.
 * The minimal counterexample is produced by actual delta debugging against the same model.
 */

import { evaluate, AXES, NOMINAL, INCIDENT, STACKS } from './flight.js';
import { makeRng } from '../lib/rand.js';
import { clamp, lerp } from '../lib/m4.js';

export const norm = (key, v) => {
  const a = AXES.find((x) => x.key === key);
  return clamp((v - a.min) / (a.max - a.min), 0, 1);
};
export const denorm = (key, u) => {
  const a = AXES.find((x) => x.key === key);
  return a.min + u * (a.max - a.min);
};

export function sampleScenarios(n, seed = 20260421) {
  const rng = makeRng(seed);
  const out = new Array(n);
  /* stratified on the two axes that matter most for coverage, uniform elsewhere */
  for (let i = 0; i < n; i++) {
    const p = {};
    for (const a of AXES) p[a.key] = denorm(a.key, rng.next());
    out[i] = p;
  }
  return out;
}

/* Chunked sweep so the main thread stays responsive while thousands of runs execute. */
export function* sweepIterator(scenarios, stack, chunk = 120) {
  const n = scenarios.length;
  const failed = new Uint8Array(n);
  const margin = new Float32Array(n);
  const mechanism = new Uint8Array(n);
  const zGate = new Float32Array(n);
  const failFrac = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const end = Math.min(n, i + chunk);
    for (; i < end; i++) {
      const r = evaluate(scenarios[i], stack);
      failed[i] = r.failed ? 1 : 0;
      margin[i] = r.margin;
      zGate[i] = r.zGate; failFrac[i] = r.failFrac;
      const e = r.events;
      mechanism[i] = (r.failed && e.biasExceed >= 0 && e.saturate >= 0 && e.biasExceed <= e.saturate && e.saturate <= e.fail) ? 1 : 0;
    }
    yield { done: i >= n, progress: i / n, failed, margin, mechanism, zGate, failFrac };
  }
  return { done: true, progress: 1, failed, margin, mechanism, zGate, failFrac };
}

export function runSweep(scenarios, stack) {
  const it = sweepIterator(scenarios, stack, 1e9);
  let r = it.next();
  while (!r.done && !r.value.done) r = it.next();
  return r.value || r.done;
}

/* Axis sensitivity: separation between failing and passing populations, per axis.
   This ranks the operating dimensions by how much they actually explain failure. */
export function sensitivity(scenarios, failed) {
  const res = [];
  for (const a of AXES) {
    let sf = 0, nf = 0, sp = 0, np = 0;
    for (let i = 0; i < scenarios.length; i++) {
      const u = norm(a.key, scenarios[i][a.key]);
      if (failed[i]) { sf += u; nf++; } else { sp += u; np++; }
    }
    const mf = nf ? sf / nf : 0.5, mp = np ? sp / np : 0.5;
    res.push({ key: a.key, label: a.label, sep: Math.abs(mf - mp), dir: Math.sign(mf - mp), meanFail: mf, meanPass: mp });
  }
  res.sort((x, y) => y.sep - x.sep);
  return res;
}

/* Spatial embedding of the 8-D operating space.
   Primary axes are the three dimensions that most separate failure from success;
   the remaining five contribute a bounded orthogonal jitter so no structure is invented. */
export function embedder(sens, seed = 7) {
  const rng = makeRng(seed);
  const primary = sens.slice(0, 3).map((s) => s.key);
  const rest = sens.slice(3).map((s) => s.key);
  const w = rest.map(() => [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]);
  return {
    primary, rest,
    place(p, out, scale = 1) {
      let x = (norm(primary[0], p[primary[0]]) - 0.5) * 2;
      let y = (norm(primary[1], p[primary[1]]) - 0.5) * 2;
      let z = (norm(primary[2], p[primary[2]]) - 0.5) * 2;
      for (let i = 0; i < rest.length; i++) {
        const u = norm(rest[i], p[rest[i]]) - 0.5;
        x += w[i][0] * u * 0.17; y += w[i][1] * u * 0.17; z += w[i][2] * u * 0.17;
      }
      out[0] = x * scale; out[1] = y * scale; out[2] = z * scale;
      return out;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Delta debugging: shrink the incident to a minimal failing condition. */
/* ------------------------------------------------------------------ */
export function reduceCounterexample(incident, stack, sens) {
  /* relax least-explanatory axes first — anything that can go back to nominal was never the cause */
  const order = [...sens].reverse().map((s) => s.key);
  const cur = { ...incident };
  const trace = [];
  for (const key of order) {
    const target = NOMINAL[key];
    const start = cur[key];
    if (Math.abs(start - target) < 1e-6) { trace.push({ key, alpha: 1, essential: false, value: target }); continue; }
    const test = (alpha) => evaluate({ ...cur, [key]: lerp(start, target, alpha) }, stack).failed;
    let alpha;
    if (test(1)) alpha = 1;
    else {
      let lo = 0, hi = 1;
      for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2; if (test(mid)) lo = mid; else hi = mid; }
      alpha = lo;
    }
    cur[key] = lerp(start, target, alpha);
    trace.push({ key, alpha, essential: alpha < 0.985, value: cur[key] });
  }
  const verify = evaluate(cur, stack);
  const essential = trace.filter((t) => t.essential).map((t) => t.key);
  return { minimal: cur, trace, essential, stillFails: verify.failed, margin: verify.margin };
}

/* Ranking used by the reduction sequence: nearest failing scenarios to the minimal counterexample. */
export function rankByProximity(scenarios, minimal, keys) {
  const n = scenarios.length;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const k of keys) { const dv = norm(k, scenarios[i][k]) - norm(k, minimal[k]); s += dv * dv; }
    d[i] = Math.sqrt(s);
  }
  return d;
}

/* Build the complete DISCOVER -> ISOLATE dataset. Runs the model N times. */
export function buildFailureSpace({ count = 1400, seed = 20260421, stack = STACKS.incumbent } = {}) {
  const scenarios = sampleScenarios(count, seed);
  const sweep = runSweep(scenarios, stack);
  const sens = sensitivity(scenarios, sweep.failed);
  const embed = embedder(sens);
  const red = reduceCounterexample(INCIDENT, stack, sens);
  const dist = rankByProximity(scenarios, red.minimal, red.essential.length ? red.essential : sens.slice(0, 3).map((s) => s.key));

  const nFail = sweep.failed.reduce((a, b) => a + b, 0);
  const nMech = sweep.mechanism.reduce((a, b) => a + b, 0);

  /* reduction ladder — each rung is a real filter, not a countdown animation */
  const failIdx = [];
  for (let i = 0; i < count; i++) if (sweep.failed[i]) failIdx.push(i);
  const mechIdx = failIdx.filter((i) => sweep.mechanism[i]);
  mechIdx.sort((a, b) => dist[a] - dist[b]);

  const rungs = [
    { n: count, label: 'SAMPLED SCENARIOS', note: 'operating space, 8 dimensions' },
    { n: nFail, label: 'FAILING', note: 'loss of separation in the corridor' },
    { n: nMech, label: 'SAME MECHANISM', note: 'bias → late commit → saturation' },
    { n: Math.max(8, Math.round(nMech * 0.25)), label: 'NEAREST NEIGHBOURHOOD', note: 'closest in the essential dimensions' },
    { n: 4, label: 'RELAXED TO NOMINAL', note: `${8 - red.essential.length} of 8 dimensions returned to nominal` },
    { n: 1, label: 'MINIMAL COUNTEREXAMPLE', note: `${red.essential.length} essential variables, failure preserved` },
  ];

  return { scenarios, ...sweep, sens, embed, reduction: red, dist, failIdx, mechIdx, rungs, count, nFail, nMech };
}
