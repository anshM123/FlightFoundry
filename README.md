# FlightFoundry

The website for FlightFoundry — the continuous improvement system for autonomous flight.

A scroll-driven, single-scene WebGL film. Scroll position is simulation time: an autonomous
aircraft flies a real plan, fails, and the failure is discovered, isolated, diagnosed, repaired,
independently verified and released — after which the same aircraft flies the same scenario again
and succeeds.

**Zero dependencies. No build step. No bundler. No package manager.** Clone it, open `index.html`,
or push it to GitHub Pages. Everything — the renderer, the aircraft, the environment, the physics
and every figure — is generated in code at runtime.

---

## The thing that makes it not a landing page

Underneath the visuals is a small but real autonomy stack, in
[`assets/js/sim/flight.js`](assets/js/sim/flight.js):

| Stage | What it actually does |
| --- | --- |
| Perception | A detectability model driven by scene contrast, structural member size, sensor noise, closing speed and range |
| Estimation | A scalar Kalman filter tracking the lateral position of the passable corridor, with process noise and confidence-weighted measurement noise |
| Planning | A fixed-rate replanner that tracks the estimate, inflated by state uncertainty, gated on estimate confidence |
| Control | A saturating PD+I lateral controller with authority limited by battery state, under a crosswind disturbance |

Nothing on the site is keyframed. The incident is what happens when you run that model with the
recorded operating conditions:

```
T+5.02   detectability falls below the usable floor
T+7.26   corridor estimate biased by more than 2.2 m
T+7.26   planner commits to the biased estimate
T+7.26   lateral acceleration command exceeds available authority
T+7.70   confidence finally rises — the correction starts too late
T+9.58   loss of separation, −5.23 m against a 2.65 m requirement
```

Run the same scenario against the candidate configuration and it clears the corridor by +2.18 m.
Both runs are computed in your browser when the page loads. So are these:

* **The failure space.** ~2,200 operating conditions are sampled across eight dimensions and each
  one is executed. The failure regions in the scenario cloud are emergent, not drawn.
* **The counterexample.** The minimal failing scenario is produced by actual delta debugging
  against the same model — greedily relaxing each dimension back to nominal while the failure
  survives. Five of eight dimensions relax completely; three are essential.
* **The causal chain.** The timestamps in the diagnosis are the event times the simulation
  recorded.
* **The plots on `/system`.** Drawn from the simulator, not traced by hand.

If you change a gain in `flight.js`, the story on the homepage changes with it.

---

## Running it

```bash
# any static server; ES modules need http(s), not file://
python3 -m http.server 8080
# then open http://localhost:8080
```

### GitHub Pages

Push to a repository and enable Pages on the branch root. `.nojekyll` is included so the
`assets/` directory is served as-is. All paths are relative, so it works at a repository
subpath (`user.github.io/repo/`) without configuration.

---

## Architecture

```
index.html            the film — 18 acts, one continuous scene
system.html           workflow and architecture, with live figures
research.html         SEAL: the protected-evaluation research direction
company.html          mission, positioning, audience
contact.html          request access
assets/
  css/
    base.css          design tokens, typography, nav, footer
    home.css          the film: acts, HUD, instrumentation
    pages.css         editorial inner pages
  js/
    lib/
      m4.js           mat4/vec3 maths, easing, splines, colour
      geo.js          procedural geometry + a voxel ambient-occlusion baker
      gl.js           WebGL2 wrapper: programs, VAO meshes, instancing, render targets
      rand.js         seeded PRNG and value noise
    sim/
      flight.js       the autonomy simulation
      scenarios.js    failure-space search, sensitivity, delta debugging
    gfx/
      core.js         renderer: GGX surface shader, instanced line/point systems, HDR post
      aircraft.js     the multirotor, built from NACA blade sections
      world.js        the test range and inspection corridor
      systems.js      scenario field, causal graph, protected evaluation, loop
    ui/
      hud.js          telemetry, projected labels, data-driven copy blocks
      nav.js          navigation and the optional synthesised sound
    home.js           the director: scroll → time → camera → scene state
    pages.js          figures for the inner pages
```

### Renderer

Hand-written WebGL2. No engine.

* **Surface shading** — Cook–Torrance GGX with Smith visibility and Schlick Fresnel, three
  analytic lights, hemispheric ambient, an analytic environment term for machined metal, exponential
  depth fog for atmospheric perspective, and a silhouette-first reveal used in the opening shot.
* **Ambient occlusion** — baked at load by rasterising the model into a voxel occupancy grid and
  marching a golden-spiral hemisphere of rays per vertex. Parts occlude each other, which is what
  stops procedurally generated hardware from reading as untextured plastic.
* **Lines** — polylines expanded to constant-pixel-width quads in the vertex shader and drawn with
  instancing. One draw call renders the entire scenario cloud (~2,200 trajectories). The same system
  draws the flight path, the uncertainty envelope, the causal graph and the improvement loop.
* **Points** — instanced sprites sized either in metres or in CSS pixels, resolution-independent.
* **Post** — HDR half-float target, threshold bright pass, separable blur at two scales, ACES
  tonemapping, vignette, dither, restrained radial chromatic aberration.
* **Camera** — a physical lens shift, so the subject can sit off-centre for the copy without
  tilting the camera.

### The aircraft

A heavy-lift industrial inspection multirotor, generated from parameters, not imported:

* X-frame with four tapered arms, 0.93 m motor radius, 0.84 m rotors — 2.7 m tip to tip
* Blades lofted from genuine **NACA 0012** sections with real chord taper and twist; adjacent
  rotors counter-rotate and blur into swept discs with RPM
* Finned motor pods, shoulder clamps, taped cable runs, battery deck, GNSS mast, lidar puck,
  arch landing gear, cooling vents, antennae
* Two-axis gimballed EO head that tracks where the estimator believes the corridor is
* Attitude follows the simulation: it banks into lateral acceleration and pitches nose-down in
  proportion to airspeed, as a multirotor must

### Scroll choreography

There is no animation library and nothing is triggered. Every act is a pure function of scroll
position, so scrolling backwards runs the simulation backwards, and any scroll position renders
exactly one state. Camera poses are damped toward per-act goals with a stiffness that gives the
movement mass.

---

## Accessibility and performance

* `prefers-reduced-motion` switches the whole page to a static document: the canvas is not mounted,
  acts become ordinary sections, and the data blocks — which are DOM, not textures — still show the
  real ladder, causal chain, version delta and release gates. A notice at the top says so and offers
  a one-click **Run the full experience** button, which is remembered in `localStorage`.
* If WebGL2 is unavailable the same static presentation is used, and the notice reports the reason
  the context could not be created.
* Half-float render targets fall back to 8-bit if `EXT_color_buffer_float` is missing or the driver
  cannot render to them, rather than failing the whole scene.
* All navigation, buttons and form fields are ordinary HTML elements with visible focus states.
* Adaptive quality: sustained slow frames step down the post chain and pixel ratio. Mobile starts at
  a reduced tier with fewer particles, simplified camera movement and no lens shift.
* Sound is off by default, synthesised (no audio files), and the site is designed to be equally good
  muted.

### Debug parameters

| Query | Effect |
| --- | --- |
| `?q=0` / `?q=1` / `?q=2` | Pin the post-processing quality tier |
| `?dpr=1` | Pin the device pixel ratio |
| `?snap=1` | Disable scroll and camera easing (deterministic frames for capture) |
| `?debug=1` | Expose `window.__ff` with the scene state, stage and camera |
| `?motion=1` / `?motion=0` | Force the film on or off, overriding the OS reduced-motion setting |

---

## Notes on content

Every figure, margin, version identifier and scenario count on this site is produced by the
demonstration model running in the browser. There are no customer results, case studies,
benchmarks, testimonials or deployment statistics anywhere in this repository, and SEAL is
presented as an active research direction with no results claimed.

The contact form is a static build with no backend: it composes the request in the visitor's mail
client. Replace the handler in `assets/js/pages.js` to point at a real endpoint.

Typography is Archivo and IBM Plex Mono, loaded from Google Fonts with a system fallback stack; the
site degrades gracefully offline.

---

## Licence

MIT. See [LICENSE](LICENSE).
