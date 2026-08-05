/* FlightFoundry — deterministic autonomy simulation.
 *
 * This is a real (if small) autonomy stack, not an animation script:
 *   perception  -> detectability model driven by contrast, member size, sensor noise, closing speed
 *   estimation  -> scalar Kalman filter on the lateral position of the passable gap
 *   planning    -> fixed-rate replanner tracking the estimate, inflated by state uncertainty
 *   control     -> saturating PD lateral controller under crosswind disturbance
 *
 * The incident sequence shown on the site is the output of this model, not a keyframed cartoon.
 * The corrected flight is the same model run with a different autonomy configuration.
 */

import { clamp, sat, smoothstep } from '../lib/m4.js';
import { fbm1 } from '../lib/rand.js';

/* --- test range geometry (metres) --- */
export const RANGE = {
  gateX: 232,        // longitudinal station of the gate structure
  gapZ: 2.4,         // true lateral centre of the passable gap
  gapHalf: 4.8,      // half-width of the passable gap
  gateDepth: 34,     // longitudinal depth of the inspection corridor
  spanHalf: 1.35,    // aircraft semi-span
  reqClear: 0.8,     // required clearance to structure
  alt: 38,
  length: 300,
};
export const failLimit = () => RANGE.gapHalf - RANGE.spanHalf - RANGE.reqClear;
export const FAIL_LIMIT = failLimit();

/* --- operating-condition axes. These eight are the failure-search dimensions. --- */
export const AXES = [
  { key: 'wind', label: 'WIND', unit: 'm/s', min: 0, max: 14, fmt: (v) => v.toFixed(1) },
  { key: 'light', label: 'LIGHT', unit: 'contrast', min: 0.05, max: 1, fmt: (v) => v.toFixed(2) },
  { key: 'noise', label: 'SENSOR NOISE', unit: 'σ', min: 0.02, max: 0.5, fmt: (v) => v.toFixed(2) },
  { key: 'latency', label: 'LATENCY', unit: 's', min: 0.04, max: 0.3, fmt: (v) => v.toFixed(3) },
  { key: 'geometry', label: 'OBSTACLE GEOMETRY', unit: 'm', min: 0.06, max: 0.5, fmt: (v) => v.toFixed(2) },
  { key: 'speed', label: 'RELATIVE VELOCITY', unit: 'm/s', min: 10, max: 26, fmt: (v) => v.toFixed(1) },
  { key: 'battery', label: 'BATTERY STATE', unit: 'soc', min: 0.15, max: 1, fmt: (v) => v.toFixed(2) },
  { key: 'locError', label: 'LOCALIZATION ERROR', unit: 'm', min: 0, max: 4.0, fmt: (v) => v.toFixed(2) },
];

export const NOMINAL = { wind: 3.2, light: 0.74, noise: 0.10, latency: 0.09, geometry: 0.34, speed: 15.5, battery: 0.88, locError: 0.20 };

/* The recorded incident. Every number here is an input, not a result. */
export const INCIDENT = { wind: 9.6, light: 0.16, noise: 0.33, latency: 0.25, geometry: 0.11, speed: 22.4, battery: 0.42, locError: 1.30 };

/* --- autonomy configurations. Version strings are illustrative. --- */
export const STACKS = {
  incumbent: {
    id: 'v27.4', name: 'INCUMBENT',
    detFloor: 0.093,      // detectability below which perception yields no usable confidence
    detWidth: 0.056,      // in poor contrast, usable confidence arrives late and biased
    replanGain: 1.0,      // replan rate multiplier
    inflationK: 1.0,      // uncertainty inflation on the commanded corridor
    trackKp: 1.95, trackKd: 2.3, trackKi: 0.10,
    commitConf: 0.0,      // commits to the estimate at any confidence — this is the defect
    aMax: 11.0,
  },
  candidate: {
    id: 'v27.5', name: 'CANDIDATE',
    detFloor: 0.040,      // low-contrast perception repaired
    detWidth: 0.055,
    replanGain: 1.9,      // replans twice as often
    inflationK: 0.9,      // corridor inflation re-fitted to the new estimator
    trackKp: 1.35, trackKd: 2.45, trackKi: 0.80,  // integral term rejects steady crosswind
    commitConf: 0.70,     // will not steer on a low-confidence estimate
    aMax: 11.0,
  },
};

export const TUNING = {
  SENSOR_HZ: 25,    // perception update rate
  DETECT_R: 120,    // nominal detection range for the gate structure
  BIAS_GAIN: 15.0,   // lateral position bias induced by low-confidence observations
  BIAS_EXP: 1.2,
  Q_PROC: 1.55,     // estimator process noise
  R0: 0.32,         // measurement noise floor
  WIND_K: 0.11,    // crosswind -> lateral acceleration coupling
};

export function detectability(p, range) {
  const rangeF = clamp(1.5 - range / TUNING.DETECT_R, 0, 1.4);
  const closing = clamp((p.speed - 13) / 15, 0, 1);
  const base = Math.pow(clamp(p.light, 0.01, 1), 0.6)
    * clamp(p.geometry / 0.22, 0, 1.3)
    * (1 - 0.55 * p.noise)
    * (1 - 0.35 * closing);
  return base * rangeF;
}

function windLat(p, t) {
  const gust = 0.55 + 0.45 * clamp(fbm1(t * 1.15 + 4.7, 3) * 1.9, -1, 1);
  return -p.wind * TUNING.WIND_K * gust;
}

/* ---------------------------------------------------------------- */
/* Full simulation with recording                                    */
/* ---------------------------------------------------------------- */
export function simulate(params, stack, { dt = 0.02, record = true } = {}) {
  const p = { ...NOMINAL, ...params };
  const s = stack;
  const nMax = Math.ceil((RANGE.length / Math.max(6, p.speed)) / dt) + 8;

  const rec = record ? {
    n: 0, dt,
    t: new Float32Array(nMax), x: new Float32Array(nMax), y: new Float32Array(nMax), z: new Float32Array(nMax),
    vz: new Float32Array(nMax), conf: new Float32Array(nMax), det: new Float32Array(nMax),
    P: new Float32Array(nMax), zHat: new Float32Array(nMax), zRef: new Float32Array(nMax),
    aCmd: new Float32Array(nMax), effort: new Float32Array(nMax), satF: new Float32Array(nMax),
    wind: new Float32Array(nMax), range: new Float32Array(nMax), pitch: new Float32Array(nMax), roll: new Float32Array(nMax),
  } : null;

  let t = 0, x = 0, y = RANGE.alt, z = 0, vz = 0, vy = 0;
  const locSign = p.locError > 0 ? -1 : 1;
  let zHat = RANGE.gapZ + locSign * p.locError;
  const zPrior = zHat;
  let P = 9.0;
  let zRef = 0;
  let sensorAcc = 0, planAcc = 0, integ = 0;
  const planPeriod = Math.max(0.02, p.latency / s.replanGain);
  const aMax = s.aMax * (0.26 + 0.74 * clamp(p.battery, 0, 1));

  let failed = false, failTime = -1, failIndex = -1, crossed = false, missMargin = 0;
  let zGate = 0, gateSeen = false, tEnd = 0;
  let minMargin = 1e9;
  const ev = { confDrop: -1, biasExceed: -1, lateReplan: -1, saturate: -1, fail: -1, detect: -1 };
  let lastCommitZ = 0, prevSat = false;

  for (let i = 0; i < nMax; i++) {
    const range = RANGE.gateX - x;
    const det = detectability(p, Math.max(0, range));
    const conf = range > 0 && range < TUNING.DETECT_R * 1.45 ? smoothstep(s.detFloor, s.detFloor + s.detWidth, det) : 0;

    /* --- sensing --- */
    sensorAcc += dt;
    if (sensorAcc >= 1 / TUNING.SENSOR_HZ) {
      sensorAcc = 0;
      if (conf > 0.02 && range > 0) {
        const bias = -TUNING.BIAS_GAIN * Math.pow(1 - conf, TUNING.BIAS_EXP);
        const jitter = (fbm1(t * 9.1 + 11.3, 2)) * 1.6 * p.noise;
        const meas = RANGE.gapZ + bias + jitter;
        const R = TUNING.R0 / (conf * conf + 0.012);
        const K = P / (P + R);
        zHat += K * (meas - zHat);
        P *= (1 - K);
        if (ev.detect < 0 && conf > 0.15) ev.detect = t;
      }
    }
    P += TUNING.Q_PROC * dt;

    /* --- planning --- */
    planAcc += dt;
    if (planAcc >= planPeriod) {
      planAcc = 0;
      const inflation = s.inflationK * Math.sqrt(Math.max(0, P)) * 0.16;
      /* bias the commanded lateral target away from the nearer pylon by the uncertainty inflation */
      const usable = conf >= (s.commitConf || 0) || range < 22;
      const side = zHat < RANGE.gapZ ? 1 : -1;
      const newRef = usable ? zHat + side * Math.min(inflation, RANGE.gapHalf * 0.5) : zPrior;
      if (Math.abs(newRef - lastCommitZ) > 2.0 && range < 70 && ev.lateReplan < 0) ev.lateReplan = t;
      lastCommitZ = newRef;
      zRef = newRef;
    }

    /* --- control --- */
    const wl = windLat(p, t);
    const err = zRef - z;
    integ = clamp(integ + err * dt, -6, 6);
    let aCmd = s.trackKp * err - s.trackKd * vz + (s.trackKi || 0) * integ;
    const saturated = Math.abs(aCmd) > aMax;
    if (saturated && ev.saturate < 0 && range < 120) ev.saturate = t;
    const aClamped = clamp(aCmd, -aMax, aMax);
    const effort = clamp(Math.abs(aCmd) / aMax, 0, 1.6);

    vz += (aClamped + wl) * dt;
    z += vz * dt;
    /* mild vertical: terrain following profile + wind coupling */
    const yTarget = RANGE.alt + Math.sin(x * 0.011) * 2.6 - clamp((x - 150) / 150, 0, 1) * 3.2;
    vy += ((yTarget - y) * 0.9 - vy * 1.7) * dt + wl * 0.06 * dt;
    y += vy * dt;
    x += p.speed * dt;

    if (ev.confDrop < 0 && range < 120 && range > 0 && conf < 0.2) ev.confDrop = t;
    if (ev.biasExceed < 0 && range < 115 && Math.abs(zHat - RANGE.gapZ) > 2.2) ev.biasExceed = t;

    const margin = failLimit() - Math.abs(z - RANGE.gapZ);
    const inCorridor = x >= RANGE.gateX - RANGE.gateDepth / 2 && x <= RANGE.gateX + RANGE.gateDepth / 2;
    if (!gateSeen && inCorridor) { gateSeen = true; zGate = z - RANGE.gapZ; }
    if (inCorridor) {
      minMargin = Math.min(minMargin, margin);
      if (!failed && margin < 0) {
        failed = true; failTime = t; failIndex = record ? rec.n : i; ev.fail = t; missMargin = margin;
      }
    }

    if (record) {
      const k = rec.n++;
      rec.t[k] = t; rec.x[k] = x; rec.y[k] = y; rec.z[k] = z; rec.vz[k] = vz;
      rec.conf[k] = conf; rec.det[k] = det; rec.P[k] = P; rec.zHat[k] = zHat; rec.zRef[k] = zRef;
      rec.aCmd[k] = aCmd; rec.effort[k] = effort; rec.satF[k] = saturated ? 1 : 0; rec.wind[k] = wl;
      rec.range[k] = range;
      rec.roll[k] = clamp(-aClamped / aMax, -1, 1) * 0.62;
      rec.pitch[k] = clamp(-vy * 0.06, -0.25, 0.25) + 0.03;
    }

    if (!crossed && x >= RANGE.gateX + RANGE.gateDepth / 2) { crossed = true; if (!failed) missMargin = minMargin; }
    if (failed) break;
    if (x > RANGE.length) break;
    prevSat = saturated;
    t += dt; tEnd = t;
  }
  if (minMargin > 1e8) minMargin = missMargin;

  const total = RANGE.length / p.speed;
  return { rec, failed, failTime, failIndex, missMargin, minMargin, events: ev, params: p, stack: s, planPeriod, aMax,
    zGate, failFrac: failed ? clamp(failTime / total, 0, 1) : 1, tEnd };
}

/* Fast pass/fail evaluation used for scenario sweeps (no recording). */
export function evaluate(params, stack, dt = 0.05) {
  const r = simulate(params, stack, { dt, record: false });
  return { failed: r.failed, margin: r.missMargin, events: r.events, zGate: r.zGate, failFrac: r.failFrac };
}

/* Forward-integrate the planner's own prediction from a recorded state.
   The planner does not model the gust, which is exactly why predicted and actual diverge. */
export function predictFrom(rec, i, stack, params, horizon = 2.6, steps = 34) {
  const p = { ...NOMINAL, ...params };
  const aMax = stack.aMax * (0.5 + 0.5 * clamp(p.battery, 0, 1));
  const dt = horizon / steps;
  let z = rec.z[i], vz = rec.vz[i], x = rec.x[i], y = rec.y[i];
  const zRef = rec.zRef[i];
  const out = new Float32Array(steps * 3);
  for (let k = 0; k < steps; k++) {
    const aCmd = clamp(stack.trackKp * (zRef - z) - stack.trackKd * vz, -aMax, aMax);
    vz += aCmd * dt; z += vz * dt; x += p.speed * dt;
    const yT = RANGE.alt + Math.sin(x * 0.011) * 2.6 - clamp((x - 150) / 150, 0, 1) * 3.2;
    y += (yT - y) * Math.min(1, dt * 2.4);
    out[k * 3] = x; out[k * 3 + 1] = y; out[k * 3 + 2] = z;
  }
  return out;
}

export function sampleAt(rec, i) {
  const k = clamp(Math.round(i), 0, rec.n - 1);
  return {
    t: rec.t[k], x: rec.x[k], y: rec.y[k], z: rec.z[k], conf: rec.conf[k], P: rec.P[k],
    zHat: rec.zHat[k], zRef: rec.zRef[k], effort: rec.effort[k], sat: rec.satF[k],
    wind: rec.wind[k], range: rec.range[k], roll: rec.roll[k], pitch: rec.pitch[k], vz: rec.vz[k],
  };
}

/* smooth interpolated read for scrubbing */
export function lerpAt(rec, f) {
  const fi = clamp(f, 0, rec.n - 1.001);
  const i = Math.floor(fi), u = fi - i, j = Math.min(rec.n - 1, i + 1);
  const g = (arr) => arr[i] + (arr[j] - arr[i]) * u;
  return {
    t: g(rec.t), x: g(rec.x), y: g(rec.y), z: g(rec.z), vz: g(rec.vz), conf: g(rec.conf),
    P: g(rec.P), zHat: g(rec.zHat), zRef: g(rec.zRef), effort: g(rec.effort), sat: g(rec.satF),
    wind: g(rec.wind), range: g(rec.range), roll: g(rec.roll), pitch: g(rec.pitch), det: g(rec.det),
    index: i,
  };
}
