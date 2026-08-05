/* FlightFoundry — inner pages.
   Figures are drawn from the same simulator the homepage runs, so the plots on these
   pages are outputs of the model rather than illustrations of it. */

import { simulate, INCIDENT, NOMINAL, STACKS, RANGE, AXES, failLimit } from './sim/flight.js';
import { buildFailureSpace } from './sim/scenarios.js';
import { clamp, lerp } from './lib/m4.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ */
/* Figure 1 — the incident and the corrected flight, same scenario      */
/* ------------------------------------------------------------------ */
function figTrajectory(el) {
  const A = simulate(INCIDENT, STACKS.incumbent, { dt: 0.02 });
  const B = simulate(INCIDENT, STACKS.candidate, { dt: 0.02 });
  const W = 860, H = 260, padL = 46, padR = 130, padT = 22, padB = 30;
  const x0 = 0, x1 = RANGE.length;
  const z0 = -8, z1 = 8;
  const sx = (x) => padL + ((x - x0) / (x1 - x0)) * (W - padL - padR);
  const sz = (z) => padT + (1 - (z - z0) / (z1 - z0)) * (H - padT - padB);

  const path = (rec, n) => {
    let d = '';
    const step = Math.max(1, Math.floor(n / 260));
    for (let i = 0; i < n; i += step) d += (d ? 'L' : 'M') + sx(rec.x[i]).toFixed(1) + ' ' + sz(rec.z[i]).toFixed(1) + ' ';
    return d;
  };

  const gateA = sx(RANGE.gateX - RANGE.gateDepth / 2), gateB = sx(RANGE.gateX + RANGE.gateDepth / 2);
  const lim = failLimit();
  const corrTop = sz(RANGE.gapZ + lim), corrBot = sz(RANGE.gapZ - lim);

  el.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lateral track of the incident and the corrected flight through the inspection corridor">
    <rect x="${gateA}" y="${padT}" width="${gateB - gateA}" height="${H - padT - padB}" fill="rgba(143,211,226,0.045)"/>
    <rect x="${gateA}" y="${corrTop}" width="${gateB - gateA}" height="${corrBot - corrTop}" fill="none" stroke="rgba(143,211,226,0.4)" stroke-dasharray="3 3" stroke-width="1"/>
    <line x1="${padL}" y1="${sz(RANGE.gapZ)}" x2="${W - padR}" y2="${sz(RANGE.gapZ)}" stroke="rgba(233,230,224,0.14)" stroke-width="1" stroke-dasharray="2 5"/>
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="rgba(233,230,224,0.16)" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="rgba(233,230,224,0.16)" stroke-width="1"/>
    <path d="${path(A.rec, A.rec.n)}" fill="none" stroke="var(--fail)" stroke-width="1.6"/>
    <path d="${path(B.rec, B.rec.n)}" fill="none" stroke="var(--pass)" stroke-width="1.6"/>
    <circle cx="${sx(A.rec.x[Math.max(0, A.failIndex - 1)])}" cy="${sz(A.rec.z[Math.max(0, A.failIndex - 1)])}" r="3.2" fill="var(--fail)"/>
    <text class="f" x="${sx(A.rec.x[Math.max(0, A.failIndex - 1)]) - 8}" y="${sz(A.rec.z[Math.max(0, A.failIndex - 1)]) + 3}" text-anchor="end">v27.4 loss of separation</text>
    <text class="p" x="${W - padR + 8}" y="${sz(B.rec.z[B.rec.n - 1]) + 3}">v27.5 within corridor</text>
    <text class="k" x="${(gateA + gateB) / 2}" y="${padT - 6}" text-anchor="middle">inspection corridor</text>
    <text x="${padL}" y="${H - 10}">0 m</text>
    <text x="${W - padR}" y="${H - 10}" text-anchor="end">${RANGE.length} m along track</text>
    <text x="6" y="${padT + 8}">+8 m</text>
    <text x="6" y="${H - padB}">−8 m</text>
  </svg>`;
  const cap = el.parentElement && el.parentElement.querySelector('figcaption');
  if (cap) {
    cap.textContent = `Lateral track, identical scenario. Incumbent v27.4 clearance margin ${A.missMargin.toFixed(2)} m; candidate v27.5 ${'+' + B.missMargin.toFixed(2)} m against a ${lim.toFixed(2)} m requirement. Computed in your browser by the demonstration model.`;
  }
}

/* ------------------------------------------------------------------ */
/* Figure 2 — sensitivity of the operating dimensions                   */
/* ------------------------------------------------------------------ */
function figSensitivity(el) {
  const fs = buildFailureSpace({ count: 900 });
  const ess = new Set(fs.reduction.essential);
  const W = 860, rowH = 24, padL = 190, padR = 150;
  const H = fs.sens.length * rowH + 26;
  let rows = '';
  fs.sens.forEach((s, i) => {
    const y = i * rowH + 18;
    const w = (W - padL - padR) * (s.sep / Math.max(0.001, fs.sens[0].sep));
    const on = ess.has(s.key);
    rows += `<text x="${padL - 12}" y="${y + 4}" text-anchor="end" ${on ? 'class="k"' : ''}>${s.label}</text>
      <rect x="${padL}" y="${y - 3}" width="${w.toFixed(1)}" height="6" fill="${on ? 'var(--sig)' : 'rgba(143,211,226,0.28)'}"/>
      <text x="${padL + w + 10}" y="${y + 4}">${s.sep.toFixed(3)}${on ? ' · essential' : ''}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Separation between failing and passing populations for each operating dimension">${rows}</svg>`;
  const cap = el.parentElement && el.parentElement.querySelector('figcaption');
  if (cap) cap.textContent = `${fs.count.toLocaleString()} sampled scenarios, ${fs.nFail} failing. Bars show how far each dimension separates the failing population from the passing one. Delta debugging then relaxed ${8 - fs.reduction.essential.length} of 8 dimensions back to nominal while the failure survived.`;
  return fs;
}

/* ------------------------------------------------------------------ */
/* Figure 3 — the improvement loop                                      */
/* ------------------------------------------------------------------ */
function figLoop(el) {
  const stages = ['Discover', 'Isolate', 'Diagnose', 'Repair', 'Verify', 'Release', 'Flight'];
  const W = 760, H = 250, cx = W / 2, cy = H / 2 + 6, rx = 292, ry = 82;
  let nodes = '';
  stages.forEach((s, i) => {
    const a = (i / stages.length) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
    nodes += `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" fill="${i === 4 ? 'var(--pass)' : 'var(--sig)'}" opacity="0.85"/>
      <text x="${x}" y="${y - 14}" text-anchor="middle">${s}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="The continuous improvement loop">
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="rgba(143,211,226,0.30)" stroke-width="1"/>
    ${nodes}
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* Figure 4 — SEAL: the constrained feedback channel                    */
/* ------------------------------------------------------------------ */
function figSeal(el) {
  const W = 760, H = 240;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="A repair loop measured against a protected evaluator through a constrained feedback channel">
    <rect x="40" y="70" width="150" height="100" fill="none" stroke="rgba(233,230,224,0.28)"/>
    <text x="115" y="60" text-anchor="middle">Repair process</text>
    <rect x="470" y="42" width="200" height="156" fill="rgba(143,211,226,0.05)" stroke="rgba(143,211,226,0.5)"/>
    <text class="k" x="570" y="32" text-anchor="middle">Protected evaluation</text>
    <text x="570" y="112" text-anchor="middle">hidden scenarios</text>
    <text x="570" y="128" text-anchor="middle">never exposed</text>
    <path d="M190 100 H470" stroke="rgba(233,230,224,0.4)" stroke-width="1" marker-end="url(#ar)"/>
    <text x="330" y="92" text-anchor="middle">candidate version</text>
    <path d="M470 150 H190" stroke="var(--warn)" stroke-width="1" stroke-dasharray="4 4" marker-end="url(#aw)"/>
    <text x="330" y="168" text-anchor="middle">constrained feedback</text>
    <rect x="316" y="140" width="28" height="20" fill="none" stroke="var(--warn)"/>
    <text x="330" y="196" text-anchor="middle">information budget</text>
    <defs>
      <marker id="ar" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="rgba(233,230,224,0.5)"/></marker>
      <marker id="aw" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="var(--warn)"/></marker>
    </defs>
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* Contact form                                                         */
/* ------------------------------------------------------------------ */
function initForm() {
  const form = $('#access-form');
  if (!form) return;
  const msg = $('#form-msg');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) {
      msg.dataset.state = 'err';
      msg.textContent = 'A work email address is required.';
      return;
    }
    /* No backend is wired to this static build: hand the request to the user's mail client. */
    const body = [
      `Name: ${data.name || ''}`,
      `Work email: ${data.email}`,
      `Company / lab: ${data.company || ''}`,
      `Role: ${data.role || ''}`,
      '',
      'What are you building?',
      data.building || '',
      '',
      'How can FlightFoundry help?',
      data.help || '',
    ].join('\n');
    msg.dataset.state = '';
    msg.textContent = 'Opening your mail client…';
    window.location.href = `mailto:access@flightfoundry.example?subject=${encodeURIComponent('Request access — ' + (data.company || data.name || ''))}&body=${encodeURIComponent(body)}`;
  });
}

/* ------------------------------------------------------------------ */
function init() {
  const t = $('#fig-trajectory'); if (t) figTrajectory(t);
  const s = $('#fig-sensitivity'); if (s) figSensitivity(s);
  const l = $('#fig-loop'); if (l) figLoop(l);
  const se = $('#fig-seal'); if (se) figSeal(se);
  initForm();

  /* fill any element that wants a live number out of the model */
  const A = simulate(INCIDENT, STACKS.incumbent, { dt: 0.02 });
  const B = simulate(INCIDENT, STACKS.candidate, { dt: 0.02 });
  const vals = {
    'incident-margin': A.missMargin.toFixed(2) + ' m',
    'candidate-margin': '+' + B.missMargin.toFixed(2) + ' m',
    'requirement': failLimit().toFixed(2) + ' m',
    'fail-time': 'T+' + A.events.fail.toFixed(2) + ' s',
    'sat-time': 'T+' + A.events.saturate.toFixed(2) + ' s',
    'corridor': (RANGE.gapHalf * 2).toFixed(1) + ' m',
  };
  $$('[data-val]').forEach((el) => { if (vals[el.dataset.val]) el.textContent = vals[el.dataset.val]; });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
