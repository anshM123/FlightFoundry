/* FlightFoundry — instrumentation overlay. All typography stays in the DOM. */

import { project, clamp, lerp, damp } from '../lib/m4.js';
import { AXES, RANGE, STACKS, failLimit } from '../sim/flight.js';

/* ---------------- projected 3D labels ---------------- */
export class Labels {
  constructor(root) {
    this.root = root;
    this.items = new Map();
    this._p = new Float32Array(2);
  }
  add(id, { text = '', sub = '', cls = '', tick = false } = {}) {
    let it = this.items.get(id);
    if (!it) {
      const el = document.createElement('div');
      el.className = 'lbl' + (cls ? ' lbl--' + cls : '') + (tick ? ' lbl--tick' : '');
      this.root.appendChild(el);
      it = { el, pos: [0, 0, 0], vis: 0, text: null };
      this.items.set(id, it);
    }
    const html = sub ? `<b>${text}</b>${sub}` : text;
    if (it.text !== html) { it.el.innerHTML = html; it.text = html; }
    if (cls !== undefined) it.el.className = 'lbl' + (cls ? ' lbl--' + cls : '') + (tick ? ' lbl--tick' : '');
    return it;
  }
  set(id, pos, visible, opts) {
    const it = opts ? this.add(id, opts) : this.items.get(id);
    if (!it) return;
    it.pos[0] = pos[0]; it.pos[1] = pos[1]; it.pos[2] = pos[2];
    it.want = visible;
  }
  hideAll() { for (const it of this.items.values()) it.want = 0; }
  render(vp, w, h, dt) {
    for (const it of this.items.values()) {
      const cw = project(this._p, vp, it.pos);
      const on = it.want && cw > 0 && this._p[0] > -0.15 && this._p[0] < 1.15 && this._p[1] > -0.15 && this._p[1] < 1.15;
      it.vis = damp(it.vis, on ? 1 : 0, 9, dt);
      const el = it.el;
      if (it.vis < 0.004) { if (el.style.opacity !== '0') el.style.opacity = '0'; continue; }
      el.style.opacity = it.vis.toFixed(3);
      el.style.transform = `translate(${(this._p[0] * w).toFixed(1)}px, ${(this._p[1] * h).toFixed(1)}px) translate(${el.classList.contains('lbl--tick') ? '0' : '-50%'}, -50%)`;
    }
  }
}

/* ---------------- telemetry ---------------- */
export class Hud {
  constructor(root) {
    this.root = root;
    this.state = root.querySelector('#hud-state');
    this.sim = root.querySelector('#hud-sim');
    this.f = {};
    root.querySelectorAll('[data-tel]').forEach((el) => { this.f[el.dataset.tel] = el; });
    this.v = { alt: 0, vel: 0, wind: 0, perc: 0, loc: 0, plan: 0, ctrl: 0 };
    this.navInstr = document.querySelectorAll('#nav-instr [data-instr]');
  }
  set(name, text, level) {
    const el = this.f[name];
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    const lv = level || '';
    if (el.dataset.level !== lv) el.dataset.level = lv;
  }
  setState(s, label) {
    if (this.state.dataset.state !== s) this.state.dataset.state = s;
    if (this.state.textContent !== label) this.state.textContent = label;
    if (this.navInstr[1] && this.navInstr[1].textContent !== 'STATE ' + label) this.navInstr[1].textContent = 'STATE ' + label;
  }
  setSim(t) {
    if (this.sim && this.sim.textContent !== t) this.sim.textContent = t;
    if (this.navInstr[0] && this.navInstr[0].textContent !== t.split(' · ')[0]) this.navInstr[0].textContent = t.split(' · ')[0];
  }
  setTime(t) {
    if (this.navInstr[2]) {
      const s = 'T+' + t.toFixed(1);
      if (this.navInstr[2].textContent !== s) this.navInstr[2].textContent = s;
    }
  }
  /* values interpolate rather than jump */
  update(s, dt, stack) {
    const v = this.v;
    v.alt = damp(v.alt, s.y, 7, dt);
    v.vel = damp(v.vel, s.vel, 7, dt);
    v.wind = damp(v.wind, s.windSpeed, 5, dt);
    v.perc = damp(v.perc, s.conf, 8, dt);
    v.loc = damp(v.loc, Math.sqrt(Math.max(0, s.P)), 6, dt);
    v.ctrl = damp(v.ctrl, s.effort, 9, dt);
    this.set('alt', v.alt.toFixed(1) + ' m');
    this.set('vel', v.vel.toFixed(1) + ' m/s');
    this.set('wind', v.wind.toFixed(1) + ' m/s', v.wind > 7 ? 'warn' : '');
    this.set('perc', (v.perc * 100).toFixed(0).padStart(2, '0') + ' %', v.perc < 0.25 ? (s.range < 120 ? 'warn' : '') : '');
    this.set('loc', '±' + v.loc.toFixed(2) + ' m', v.loc > 3.2 ? 'warn' : '');
    this.set('plan', s.planLabel, s.planLevel);
    this.set('ctrl', (v.ctrl * 100).toFixed(0) + ' %', v.ctrl > 0.98 ? 'fail' : v.ctrl > 0.7 ? 'warn' : '');
    this.set('policy', stack.id, stack === STACKS.candidate ? 'pass' : '');
  }
}

/* ---------------- data-driven copy blocks ---------------- */
export function buildAxes(el, fs) {
  if (!el) return;
  const ess = new Set(fs.reduction.essential);
  el.innerHTML = fs.sens.map((s) => `
    <li data-essential="${ess.has(s.key) ? 1 : 0}">
      <b>${s.label}</b><span class="bar"><i style="--v:${s.sep.toFixed(3)}"></i></span>
    </li>`).join('');
}

export function buildLadder(el, fs) {
  if (!el) return;
  el.innerHTML = fs.rungs.map((r, i) => `
    <div class="ladder__row" data-on="0" data-final="${i === fs.rungs.length - 1 ? 1 : 0}">
      <span class="ladder__n">${r.n.toLocaleString()}</span>
      <span class="ladder__l">${r.label}</span>
      <span class="ladder__note">${r.note}</span>
    </div>`).join('');
  return [...el.querySelectorAll('.ladder__row')];
}

export function buildChain(el, chain) {
  if (!el) return [];
  el.innerHTML = chain.map((c) => `
    <li data-on="0" data-fail="${c.fail ? 1 : 0}">
      <span class="t">T+${c.t.toFixed(2)}</span>
      <span>${c.text}</span>
    </li>`).join('');
  return [...el.querySelectorAll('li')];
}

export function buildDelta(el, rows) {
  if (!el) return [];
  el.innerHTML = `<div class="delta__head"><span>Change</span><span>v27.4</span><span>v27.5</span></div>` +
    rows.map((r) => `<div class="delta__row" data-on="0"><span>${r.label}</span><span class="old">${r.a}</span><span class="new">${r.b}</span></div>`).join('');
  return [...el.querySelectorAll('.delta__row')];
}

export function buildGates(el, rows) {
  if (!el) return [];
  el.innerHTML = rows.map((r) => `
    <div class="gate" data-on="0" data-r="idle"><span class="gate__l">${r.label}</span><span class="gate__v">—</span></div>`).join('');
  return [...el.querySelectorAll('.gate')];
}

export function buildBudget(el) {
  if (!el) return null;
  el.innerHTML = `
    <div class="budget__bar"><i style="--v:0"></i></div>
    <div class="budget__row"><span>Information released from the evaluator</span><span data-budget-v>0%</span></div>`;
  return { bar: el.querySelector('i'), val: el.querySelector('[data-budget-v]') };
}

export function buildFailureMeta(el, run) {
  if (!el) return;
  const ev = run.events;
  const items = [
    ['Event', 'Loss of separation', true],
    ['Station', `x = ${RANGE.gateX} m, corridor entry`, false],
    ['Clearance margin', `${run.missMargin.toFixed(2)} m of ${failLimit().toFixed(2)} m`, true],
    ['Mission time', `T+${ev.fail.toFixed(2)} s`, false],
    ['Autonomy version', 'v27.4 (illustrative)', false],
    ['Preceding', `saturation at T+${ev.saturate.toFixed(2)} s`, false],
  ];
  el.innerHTML = items.map(([k, v, f]) => `<div><dt>${k}</dt><dd class="${f ? 'is-fail' : ''}">${v}</dd></div>`).join('');
}
