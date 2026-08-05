/* FlightFoundry — rendering core.
   Physically-motivated GGX surface shading, screen-space instanced line rendering,
   instanced point sprites, and a small HDR post chain. Hand written, no engine. */

import { Program, Mesh, RenderTarget, fullscreenMesh, FS_VERT, createContext, meshFromGeometry } from '../lib/gl.js';
import { m4, perspective, lookAt, mul, invert, normalMat3, identity, trs, v3, hexToLinear, clamp } from '../lib/m4.js';

/* ---------------------------------------------------------------- */
/* shared GLSL                                                       */
/* ---------------------------------------------------------------- */
const COMMON = `
const float PI = 3.14159265359;
float sat1(float x){ return clamp(x,0.0,1.0); }
vec3 acesTonemap(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);
}
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
`;

const SURFACE_VS = `#version 300 es
precision highp float;
in vec3 aPos; in vec3 aNormal; in vec2 aUv; in vec3 aAux;
uniform mat4 uModel, uViewProj; uniform mat3 uNormalMat;
out vec3 vN; out vec3 vW; out vec2 vUv; out vec3 vAux; out vec3 vLocal;
void main(){
  vec4 w = uModel*vec4(aPos,1.0);
  vW = w.xyz; vLocal = aPos; vN = normalize(uNormalMat*aNormal); vUv = aUv; vAux = aAux;
  gl_Position = uViewProj*w;
}`;

const SURFACE_FS = `#version 300 es
precision highp float;
${COMMON}
in vec3 vN; in vec3 vW; in vec2 vUv; in vec3 vAux; in vec3 vLocal;
out vec4 outColor;

uniform vec3 uCam;
uniform vec3 uBase; uniform float uRough; uniform float uMetal;
uniform vec3 uEmis; uniform float uEmisI;
uniform float uOpacity;
uniform vec3 uRimCol; uniform float uRimI;
uniform vec3 uSky, uGround;
uniform vec3 uFogCol; uniform float uFogK;
uniform vec3 uL0d, uL0c, uL1d, uL1c, uL2d, uL2c;
uniform float uReveal;      /* 0..1 edge-lit reveal used in the hero */
uniform float uWire;        /* panel-line intensity */
uniform vec4 uCut;          /* xyz = plane normal, w = offset; >0 discards */
uniform float uAO;          /* how much baked occlusion to apply */

float D_GGX(float NoH,float a){ float a2=a*a; float d=NoH*NoH*(a2-1.0)+1.0; return a2/(PI*d*d); }
float V_Smith(float NoV,float NoL,float a){ float k=a*0.5; return 0.5/max(1e-4,(NoL*(NoV*(1.0-k)+k)+NoV*(NoL*(1.0-k)+k))); }
vec3 F_Schlick(vec3 f0,float u){ return f0+(1.0-f0)*pow(1.0-u,5.0); }

vec3 envSample(vec3 r, float rough){
  float h = r.y*0.5+0.5;
  vec3 c = mix(uGround, uSky, smoothstep(0.12, 0.9, h));
  /* soft horizon band gives machined metal something to reflect */
  float band = exp(-pow((r.y)*4.2, 2.0));
  c += uSky * band * (1.0-rough) * 1.35;
  return c;
}

vec3 shade(vec3 N, vec3 V, vec3 L, vec3 lc, vec3 albedo, float rough, float metal){
  vec3 H = normalize(V+L);
  float NoL = sat1(dot(N,L)), NoV = sat1(dot(N,V))+1e-4, NoH = sat1(dot(N,H)), VoH = sat1(dot(V,H));
  if(NoL <= 0.0) return vec3(0.0);
  float a = max(0.035, rough*rough);
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 F = F_Schlick(f0, VoH);
  float D = D_GGX(NoH, a), Vs = V_Smith(NoV, NoL, a);
  vec3 spec = F*D*Vs;
  vec3 diff = (1.0-F)*(1.0-metal)*albedo/PI;
  return (diff+spec)*lc*NoL;
}

void main(){
  if(uCut.w > -900.0 && dot(vW, uCut.xyz) - uCut.w > 0.0) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(uCam - vW);
  if(!gl_FrontFacing) N = -N;
  vec3 albedo = uBase;

  float ao = mix(1.0, clamp(vAux.x,0.0,1.0), uAO);
  vec3 col = vec3(0.0);
  col += shade(N,V,normalize(uL0d),uL0c,albedo,uRough,uMetal);
  col += shade(N,V,normalize(uL1d),uL1c,albedo,uRough,uMetal);
  col += shade(N,V,normalize(uL2d),uL2c,albedo,uRough,uMetal);

  /* ambient + analytic environment specular */
  vec3 amb = mix(uGround, uSky, N.y*0.5+0.5);
  col *= mix(1.0, ao, 0.45);
  col += albedo*amb*(1.0-uMetal*0.75)*ao*ao;
  vec3 R = reflect(-V,N);
  float NoV = sat1(dot(N,V));
  vec3 f0 = mix(vec3(0.04), albedo, uMetal);
  vec3 Fenv = f0 + (max(vec3(1.0-uRough), f0)-f0)*pow(1.0-NoV,5.0);
  col += envSample(R,uRough)*Fenv*(0.30+0.70*uMetal)*mix(1.0,ao,0.85);

  /* rim: the only "glow" allowed, and it is geometric */
  float rim = pow(1.0-NoV, 3.2);
  col += uRimCol*rim*uRimI*mix(1.0,ao,0.6);

  /* hero reveal: illumination arrives along the silhouette first */
  float rev = mix(rim*1.6, 1.0, smoothstep(0.0,1.0,uReveal));
  col *= mix(0.02, 1.0, sat1(rev));

  col += uEmis*uEmisI;

  /* panel lines from uv, subtractive and subtle */
  if(uWire > 0.0){
    vec2 g = abs(fract(vUv*vec2(18.0,6.0))-0.5);
    float line = smoothstep(0.48,0.5,max(g.x,g.y));
    col *= 1.0 - line*uWire*0.55;
  }

  float dist = length(uCam-vW);
  float fog = 1.0-exp(-pow(dist*uFogK,2.0));
  col = mix(col, uFogCol, sat1(fog));

  outColor = vec4(col*uOpacity, uOpacity);
}`;

/* ---------------- instanced screen-space lines ---------------- */
const LINE_VS = `#version 300 es
precision highp float;
in vec2 aCorner;          /* x: 0|1 endpoint, y: -1|1 side */
in vec3 aA; in vec3 aB;   /* per instance */
in vec3 aMeta;            /* x: rank 0..1, y: flag, z: param */
in vec2 aTs;              /* t at A, t at B */
uniform mat4 uViewProj; uniform vec2 uRes; uniform float uWidth;
uniform vec3 uCam;
out float vSide; out float vT; out vec3 vMeta; out float vFog; out vec3 vW;
void main(){
  vec3 wp = mix(aA,aB,aCorner.x);
  vW = wp;
  vec4 ca = uViewProj*vec4(aA,1.0);
  vec4 cb = uViewProj*vec4(aB,1.0);
  float wa = max(ca.w, 1e-4), wb = max(cb.w, 1e-4);
  vec2 sa = ca.xy/wa, sb = cb.xy/wb;
  float aspect = uRes.x/uRes.y;
  vec2 d = (sb-sa)*vec2(aspect,1.0);
  if(length(d) < 1e-8) d = vec2(1.0,0.0);
  d = normalize(d);
  vec2 nrm = vec2(-d.y, d.x)/vec2(aspect,1.0);
  vec4 c = mix(ca, cb, aCorner.x);
  c.xy += nrm*aCorner.y*uWidth*c.w;
  gl_Position = c;
  vSide = aCorner.y; vT = mix(aTs.x, aTs.y, aCorner.x); vMeta = aMeta;
  vFog = length(uCam-wp);
}`;

const LINE_FS = `#version 300 es
precision highp float;
${COMMON}
in float vSide; in float vT; in vec3 vMeta; in float vFog; in vec3 vW;
out vec4 outColor;
uniform vec3 uColA, uColB;      /* flag 0 / flag 1 colours */
uniform float uAlpha;
uniform vec2 uWindow;           /* reveal window on t */
uniform float uFeather;
uniform float uDash;            /* 0 = solid */
uniform float uDashPhase;
uniform vec3 uFogCol; uniform float uFogK;
uniform float uRankCut;         /* meta.x above this fades out */
uniform float uRankSoft;
uniform float uScan;            /* scanning plane position in world x */
uniform float uScanW;
uniform vec3 uScanCol;
uniform float uHighlight;       /* meta.z == uHighlight -> emphasised */
void main(){
  float a = uAlpha;
  a *= smoothstep(uWindow.x-0.004, uWindow.x+0.004, vT);
  a *= 1.0-smoothstep(uWindow.y-0.004, uWindow.y+0.004, vT);
  a *= 1.0 - smoothstep(0.55, 1.0, abs(vSide))*uFeather;
  if(uDash > 0.0){
    float d = fract(vT*uDash + uDashPhase);
    a *= smoothstep(0.0,0.06,d)*(1.0-smoothstep(0.44,0.52,d));
  }
  float rk = 1.0 - smoothstep(uRankCut, uRankCut+uRankSoft, vMeta.x);
  a *= rk;
  vec3 c = mix(uColA, uColB, vMeta.y);
  if(uScanW > 0.0){
    float s = 1.0-smoothstep(0.0, uScanW, abs(vW.x-uScan));
    c = mix(c, uScanCol, s*0.85);
    a *= 1.0 + s*1.5;
  }
  float fog = 1.0-exp(-pow(vFog*uFogK,2.0));
  c = mix(c, uFogCol, sat1(fog)*0.85);
  a *= 1.0-sat1(fog)*0.9;
  if(a <= 0.002) discard;
  outColor = vec4(c*a, a);
}`;

/* ---------------- instanced points ---------------- */
const POINT_VS = `#version 300 es
precision highp float;
in vec2 aCorner;
in vec3 aPos; in vec3 aMeta;   /* x size, y flag, z phase */
uniform mat4 uViewProj; uniform vec2 uRes; uniform vec3 uCam;
uniform float uScale;      /* global size multiplier */
uniform float uWorld;      /* 1 = aMeta.x is metres, 0 = aMeta.x is CSS pixels */
uniform float uDpr;
uniform float uFocal;      /* 1/tan(fov/2) */
uniform vec2 uSizeClamp;   /* min/max pixel size */
out vec2 vUv; out vec3 vMeta; out float vFog;
void main(){
  vec4 c = uViewProj*vec4(aPos,1.0);
  float dist = length(uCam-aPos);
  float halfH = uRes.y*0.5;
  float pxSize = uWorld > 0.5 ? (aMeta.x*uScale*uFocal/max(0.02,dist))*halfH : aMeta.x*uScale*uDpr;
  pxSize = clamp(pxSize, uSizeClamp.x, uSizeClamp.y);
  float ndc = pxSize/halfH;
  c.xy += aCorner*vec2(ndc/(uRes.x/uRes.y), ndc)*c.w;
  gl_Position = c;
  vUv = aCorner; vMeta = aMeta; vFog = dist;
}`;

const POINT_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vUv; in vec3 vMeta; in float vFog;
out vec4 outColor;
uniform vec3 uColA, uColB; uniform float uAlpha; uniform float uSquare;
uniform vec3 uFogCol; uniform float uFogK; uniform float uReveal;
void main(){
  float d = uSquare > 0.5 ? max(abs(vUv.x),abs(vUv.y)) : length(vUv);
  float a = 1.0-smoothstep(0.72,1.0,d);
  if(uSquare > 0.5) a *= 1.0-smoothstep(0.86,1.0,d);
  a *= uAlpha;
  vec3 c = mix(uColA,uColB,vMeta.y);
  float fog = 1.0-exp(-pow(vFog*uFogK,2.0));
  a *= 1.0-sat1(fog)*0.92;
  if(a <= 0.003) discard;
  outColor = vec4(c*a, a);
}`;

/* ---------------- post chain ---------------- */
const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform float uThresh; uniform float uKnee; uniform float uExposure;
void main(){
  vec3 c = texture(uTex,vUv).rgb*uExposure;
  float l = max(c.r,max(c.g,c.b));
  float s = max(0.0, l-uThresh)/max(1e-4,l+uKnee);
  o = vec4(c*s, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform vec2 uDir;
void main(){
  vec3 c = texture(uTex,vUv).rgb*0.2270270270;
  c += texture(uTex,vUv+uDir*1.3846153846).rgb*0.3162162162;
  c += texture(uTex,vUv-uDir*1.3846153846).rgb*0.3162162162;
  c += texture(uTex,vUv+uDir*3.2307692308).rgb*0.0702702703;
  c += texture(uTex,vUv-uDir*3.2307692308).rgb*0.0702702703;
  o = vec4(c,1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
${COMMON}
in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uBloomA, uBloomB;
uniform float uBloom, uExposure, uVignette, uGrain, uTime, uAberr, uFade;
void main(){
  vec2 uv = vUv;
  vec2 d = uv-0.5;
  float r2 = dot(d,d);
  /* radial chromatic aberration, only at the extreme edge */
  float ab = uAberr*r2*r2;
  vec3 c;
  c.r = texture(uScene, uv - d*ab).r;
  c.g = texture(uScene, uv).g;
  c.b = texture(uScene, uv + d*ab).b;
  c += (texture(uBloomA,uv).rgb + texture(uBloomB,uv).rgb*0.7)*uBloom;
  c *= uExposure;
  c = acesTonemap(c);
  c *= 1.0 - uVignette*smoothstep(0.16,0.95,r2*1.9);
  float g = hash12(gl_FragCoord.xy + uTime*61.7);
  c += (g-0.5)*uGrain;
  /* ordered dither to kill banding in the deep blacks */
  float dth = hash12(gl_FragCoord.xy*1.7)-0.5;
  c += dth/255.0;
  c *= uFade;
  /* linear -> sRGB */
  c = mix(c*12.92, 1.055*pow(max(c,vec3(1e-5)),vec3(1.0/2.4))-0.055, step(vec3(0.0031308),c));
  o = vec4(c,1.0);
}`;

/* ---------------------------------------------------------------- */
export function createStage(canvas, { quality = 2 } = {}) {
  const gl = createContext(canvas);
  if (!gl) return null;

  const progs = {
    surface: new Program(gl, SURFACE_VS, SURFACE_FS, 'surface'),
    line: new Program(gl, LINE_VS, LINE_FS, 'line'),
    point: new Program(gl, POINT_VS, POINT_FS, 'point'),
    bright: new Program(gl, FS_VERT, BRIGHT_FS, 'bright'),
    blur: new Program(gl, FS_VERT, BLUR_FS, 'blur'),
    composite: new Program(gl, FS_VERT, COMPOSITE_FS, 'composite'),
  };

  const fsq = fullscreenMesh(gl);
  const rt = {
    scene: new RenderTarget(gl, 2, 2, { float: true, depth: true }),
    bright: new RenderTarget(gl, 2, 2, { float: true }),
    b1: new RenderTarget(gl, 2, 2, { float: true }),
    b2: new RenderTarget(gl, 2, 2, { float: true }),
    c1: new RenderTarget(gl, 2, 2, { float: true }),
    c2: new RenderTarget(gl, 2, 2, { float: true }),
  };

  const cam = {
    pos: v3(0, 4, 14), target: v3(0, 0, 0), up: v3(0, 1, 0), fov: 38, near: 0.4, far: 4200,
    shift: [0, 0],   /* lens shift, so the subject can sit off-centre without tilting the camera */
    proj: m4(), view: m4(), viewProj: m4(),
  };

  const state = {
    gl, progs, rt, fsq, cam, quality,
    w: 2, h: 2, dpr: 1, time: 0,
    fog: { col: hexToLinear('#070809'), k: 0.00042 },
    sky: hexToLinear('#121a22').map((v) => v * 0.62),
    ground: hexToLinear('#07080a'),
    lights: {
      l0d: v3(-0.52, 0.74, 0.42), l0c: hexToLinear('#fff2e0').map((v) => v * 6.2),
      l1d: v3(0.72, -0.34, -0.60), l1c: hexToLinear('#5f83a6').map((v) => v * 0.95),
      l2d: v3(0.06, -0.3, -0.95), l2c: hexToLinear('#9fd0e4').map((v) => v * 0.8),
    },
    grade: { bloom: 0.32, exposure: 2.9, vignette: 0.5, grain: 0.006, aberr: 0.28, fade: 1 },
  };

  function resize(w, h, dpr) {
    state.w = Math.max(2, Math.round(w * dpr));
    state.h = Math.max(2, Math.round(h * dpr));
    state.dpr = dpr;
    canvas.width = state.w; canvas.height = state.h;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    rt.scene.resize(state.w, state.h);
    const h2 = [Math.max(2, state.w >> 1), Math.max(2, state.h >> 1)];
    const h4 = [Math.max(2, state.w >> 2), Math.max(2, state.h >> 2)];
    rt.bright.resize(h2[0], h2[1]); rt.b1.resize(h2[0], h2[1]); rt.b2.resize(h2[0], h2[1]);
    rt.c1.resize(h4[0], h4[1]); rt.c2.resize(h4[0], h4[1]);
  }

  function updateCamera() {
    perspective(cam.proj, cam.fov, state.w / state.h, cam.near, cam.far);
    cam.proj[8] += cam.shift[0]; cam.proj[9] += cam.shift[1];
    lookAt(cam.view, cam.pos, cam.target, cam.up);
    mul(cam.viewProj, cam.proj, cam.view);
  }

  const _nm = new Float32Array(9);
  function drawSurface(mesh, model, mat) {
    const p = progs.surface;
    p.set('uModel', model);
    normalMat3(_nm, model);
    p.set('uNormalMat', _nm);
    p.set('uBase', mat.base); p.set('uRough', mat.rough ?? 0.5); p.set('uMetal', mat.metal ?? 0);
    p.set('uEmis', mat.emis || [0, 0, 0]); p.set('uEmisI', mat.emisI ?? 0);
    p.set('uOpacity', mat.opacity ?? 1);
    p.set('uRimCol', mat.rimCol || [0.35, 0.55, 0.65]); p.set('uRimI', mat.rimI ?? 0.02);
    p.set('uReveal', mat.reveal ?? 1);
    p.set('uWire', mat.wire ?? 0);
    p.set('uCut', mat.cut || [0, 0, 0, -1000]);
    p.set('uAO', mat.ao ?? 1);
    mesh.draw(p);
  }

  function beginSurfacePass() {
    gl.enable(gl.CULL_FACE);
    const p = progs.surface.use();
    p.set('uViewProj', cam.viewProj); p.set('uCam', cam.pos);
    p.set('uSky', state.sky); p.set('uGround', state.ground);
    p.set('uFogCol', state.fog.col); p.set('uFogK', state.fog.k);
    const L = state.lights;
    p.set('uL0d', L.l0d); p.set('uL0c', L.l0c);
    p.set('uL1d', L.l1d); p.set('uL1c', L.l1c);
    p.set('uL2d', L.l2d); p.set('uL2c', L.l2c);
    return p;
  }

  function beginLinePass() {
    gl.disable(gl.CULL_FACE);
    const p = progs.line.use();
    p.set('uViewProj', cam.viewProj); p.set('uCam', cam.pos);
    p.set('uRes', [state.w, state.h]);
    p.set('uFogCol', state.fog.col); p.set('uFogK', state.fog.k);
    p.set('uRankCut', 1e9); p.set('uRankSoft', 0.02);
    p.set('uScanW', 0); p.set('uDash', 0); p.set('uDashPhase', 0);
    p.set('uFeather', 1); p.set('uWindow', [-0.01, 1.01]);
    return p;
  }

  function beginPointPass() {
    gl.disable(gl.CULL_FACE);
    const p = progs.point.use();
    p.set('uViewProj', cam.viewProj); p.set('uCam', cam.pos);
    p.set('uRes', [state.w, state.h]);
    p.set('uFogCol', state.fog.col); p.set('uFogK', state.fog.k);
    p.set('uScale', 1); p.set('uWorld', 1); p.set('uFocal', cam.proj[5]); p.set('uDpr', state.dpr);
    p.set('uSizeClamp', [0.6, 90]);
    p.set('uReveal', 1); p.set('uSquare', 1);
    return p;
  }

  function post() {
    const q = state.quality;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    if (q > 0) {
      rt.bright.bind();
      progs.bright.use().set('uTex', rt.scene.color).set('uThresh', 0.9).set('uKnee', 0.6).set('uExposure', state.grade.exposure);
      fsq.draw(progs.bright);

      const blur = progs.blur.use();
      rt.b1.bind(); blur.set('uTex', rt.bright.color).set('uDir', [1 / rt.b1.w, 0]); fsq.draw(blur);
      rt.b2.bind(); blur.set('uTex', rt.b1.color).set('uDir', [0, 1 / rt.b2.h]); fsq.draw(blur);
      if (q > 1) {
        rt.c1.bind(); blur.set('uTex', rt.b2.color).set('uDir', [2.2 / rt.c1.w, 0]); fsq.draw(blur);
        rt.c2.bind(); blur.set('uTex', rt.c1.color).set('uDir', [0, 2.2 / rt.c2.h]); fsq.draw(blur);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, state.w, state.h);
    const c = progs.composite.use();
    c.set('uScene', rt.scene.color);
    c.set('uBloomA', q > 0 ? rt.b2.color : rt.scene.color);
    c.set('uBloomB', q > 1 ? rt.c2.color : rt.b2.color);
    c.set('uBloom', q > 0 ? state.grade.bloom : 0);
    c.set('uExposure', state.grade.exposure);
    c.set('uVignette', state.grade.vignette);
    c.set('uGrain', state.grade.grain);
    c.set('uAberr', q > 0 ? state.grade.aberr : 0);
    c.set('uFade', state.grade.fade);
    c.set('uTime', state.time);
    fsq.draw(c);
    gl.enable(gl.DEPTH_TEST);
  }

  Object.assign(state, {
    resize, updateCamera, drawSurface, beginSurfacePass, beginLinePass, beginPointPass, post,
    clear(r = 0, g = 0, b = 0) {
      rt.scene.bind();
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    },
    additive() {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
    },
    opaque() { gl.disable(gl.BLEND); gl.depthMask(true); },
  });
  return state;
}

/* ---------------------------------------------------------------- */
/* Line system: polylines rendered as instanced screen-space quads    */
/* ---------------------------------------------------------------- */
const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);
const CORNER_IDX = new Uint16Array([0, 2, 1, 2, 3, 1]);

export class LineSystem {
  /* polys: [{ pts: Float32Array(n*3) | Array<[x,y,z]>, meta:[rank,flag,extra] }] */
  constructor(gl, polys, { dynamic = false, capacity = 0 } = {}) {
    this.gl = gl;
    let segs = 0;
    for (const p of polys) segs += (p.count !== undefined ? p.count : p.pts.length / 3) - 1;
    const cap = Math.max(segs, capacity);
    this.capacity = cap;
    const A = new Float32Array(cap * 3), B = new Float32Array(cap * 3);
    const M = new Float32Array(cap * 3), T = new Float32Array(cap * 2);
    this.ranges = [];
    let s = 0;
    for (const poly of polys) {
      const n = poly.count !== undefined ? poly.count : poly.pts.length / 3;
      const start = s;
      const meta = poly.meta || [0, 0, 0];
      for (let i = 0; i < n - 1; i++, s++) {
        A[s * 3] = poly.pts[i * 3]; A[s * 3 + 1] = poly.pts[i * 3 + 1]; A[s * 3 + 2] = poly.pts[i * 3 + 2];
        B[s * 3] = poly.pts[(i + 1) * 3]; B[s * 3 + 1] = poly.pts[(i + 1) * 3 + 1]; B[s * 3 + 2] = poly.pts[(i + 1) * 3 + 2];
        M[s * 3] = meta[0]; M[s * 3 + 1] = meta[1]; M[s * 3 + 2] = meta[2];
        T[s * 2] = i / (n - 1); T[s * 2 + 1] = (i + 1) / (n - 1);
      }
      this.ranges.push({ start, count: s - start, id: poly.id });
    }
    this.count = s;
    this.A = A; this.B = B; this.M = M; this.T = T;
    this.mesh = new Mesh(gl, {
      aCorner: { data: CORNERS, size: 2 },
      aA: { data: A, size: 3, divisor: 1, dynamic },
      aB: { data: B, size: 3, divisor: 1, dynamic },
      aMeta: { data: M, size: 3, divisor: 1, dynamic },
      aTs: { data: T, size: 2, divisor: 1, dynamic },
    }, CORNER_IDX);
  }
  syncAll() {
    this.mesh.update('aA', this.A); this.mesh.update('aB', this.B);
    this.mesh.update('aMeta', this.M); this.mesh.update('aTs', this.T);
  }
  draw(prog, range = null) {
    if (!range) { this.mesh.draw(prog, this.count); return; }
    const gl = this.gl;
    this.mesh.bindFor(prog);
    /* instanced draws cannot offset instances without ANGLE_base_instance; use per-range systems instead */
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, range.count);
  }
  dispose() { this.mesh.dispose(); }
}

/* rebuildable single polyline (trajectories that change every frame) */
export class Ribbon {
  constructor(gl, maxPoints) {
    this.gl = gl; this.max = maxPoints;
    this.A = new Float32Array(maxPoints * 3);
    this.B = new Float32Array(maxPoints * 3);
    this.M = new Float32Array(maxPoints * 3);
    this.T = new Float32Array(maxPoints * 2);
    this.count = 0;
    this.mesh = new Mesh(gl, {
      aCorner: { data: CORNERS, size: 2 },
      aA: { data: this.A, size: 3, divisor: 1, dynamic: true },
      aB: { data: this.B, size: 3, divisor: 1, dynamic: true },
      aMeta: { data: this.M, size: 3, divisor: 1, dynamic: true },
      aTs: { data: this.T, size: 2, divisor: 1, dynamic: true },
    }, CORNER_IDX);
  }
  set(points, n, meta = [0, 0, 0]) {
    const segs = Math.min(this.max, n - 1);
    for (let i = 0; i < segs; i++) {
      this.A[i * 3] = points[i * 3]; this.A[i * 3 + 1] = points[i * 3 + 1]; this.A[i * 3 + 2] = points[i * 3 + 2];
      this.B[i * 3] = points[(i + 1) * 3]; this.B[i * 3 + 1] = points[(i + 1) * 3 + 1]; this.B[i * 3 + 2] = points[(i + 1) * 3 + 2];
      this.M[i * 3] = meta[0]; this.M[i * 3 + 1] = meta[1]; this.M[i * 3 + 2] = meta[2];
      this.T[i * 2] = i / Math.max(1, segs); this.T[i * 2 + 1] = (i + 1) / Math.max(1, segs);
    }
    this.count = Math.max(0, segs);
    if (this.count) {
      this.mesh.update('aA', this.A, this.count * 3);
      this.mesh.update('aB', this.B, this.count * 3);
      this.mesh.update('aMeta', this.M, this.count * 3);
      this.mesh.update('aTs', this.T, this.count * 2);
    }
  }
  draw(prog) { if (this.count) this.mesh.draw(prog, this.count); }
}

/* ---------------------------------------------------------------- */
export class PointSystem {
  constructor(gl, capacity) {
    this.gl = gl; this.capacity = capacity;
    this.P = new Float32Array(capacity * 3);
    this.M = new Float32Array(capacity * 3);
    this.count = 0;
    this.mesh = new Mesh(gl, {
      aCorner: { data: CORNERS.map((v) => (v === 0 ? -1 : v)), size: 2 },
      aPos: { data: this.P, size: 3, divisor: 1, dynamic: true },
      aMeta: { data: this.M, size: 3, divisor: 1, dynamic: true },
    }, CORNER_IDX);
  }
  sync(n) {
    this.count = Math.min(n, this.capacity);
    if (!this.count) return;
    this.mesh.update('aPos', this.P, this.count * 3);
    this.mesh.update('aMeta', this.M, this.count * 3);
  }
  draw(prog) { if (this.count) this.mesh.draw(prog, this.count); }
}

export { meshFromGeometry, identity, trs, m4 };
