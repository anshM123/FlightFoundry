/* Navigation + optional sound. Both stay ordinary HTML controls. */

const toggle = document.getElementById('navtoggle');
const links = document.getElementById('navlinks');
if (toggle && links) {
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close' : 'Menu';
  });
  links.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      links.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'Menu';
    }
  });
}

/* mark current page */
const here = location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav__links a').forEach((a) => {
  if (a.getAttribute('href') === here) a.setAttribute('aria-current', 'page');
});

/* ---------------- sound ----------------
   Synthesised, never autoplayed, and the site is designed to be equally good muted. */
const btn = document.getElementById('sound');
if (btn) {
  let ctx = null, on = false, nodes = null;
  const api = { level: 0, warn: () => {}, tone: () => {}, tick: () => {} };
  window.__ffSound = api;

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);

    /* propulsion: filtered noise + a low tone */
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 320; bp.Q.value = 1.1;
    const ng = ctx.createGain(); ng.gain.value = 0.16;
    noise.connect(bp).connect(ng).connect(master);

    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 78;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    const og = ctx.createGain(); og.gain.value = 0.05;
    osc.connect(lp).connect(og).connect(master);

    noise.start(); osc.start();
    nodes = { master, bp, osc, ng, og };

    api.warn = () => beep(430, 0.16, 'triangle', 0.05);
    api.tone = (f = 660) => beep(f, 0.5, 'sine', 0.045);
    api.tick = () => beep(1500, 0.02, 'square', 0.012);
  }
  function beep(f, dur, type, vol) {
    if (!ctx || !on) return;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(g).connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  }
  api.setLevel = (v, pitch) => {
    if (!ctx || !on || !nodes) return;
    nodes.master.gain.setTargetAtTime(0.5 * v, ctx.currentTime, 0.25);
    nodes.bp.frequency.setTargetAtTime(240 + pitch * 420, ctx.currentTime, 0.3);
    nodes.osc.frequency.setTargetAtTime(64 + pitch * 46, ctx.currentTime, 0.3);
  };
  btn.addEventListener('click', () => {
    if (!ctx) build();
    on = !on;
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Sound is on' : 'Sound is off';
    if (ctx.state === 'suspended') ctx.resume();
    nodes.master.gain.setTargetAtTime(on ? 0.35 : 0, ctx.currentTime, 0.2);
    api.enabled = on;
  });
}
