/* FlightFoundry — hand-written WebGL2 renderer core.
   No external dependencies. Programs, VAO meshes, instancing, float render targets. */

export class Program {
  constructor(gl, vs, fs, name = 'prog') {
    this.gl = gl; this.name = name;
    const v = compile(gl, gl.VERTEX_SHADER, vs, name + ':vs');
    const f = compile(gl, gl.FRAGMENT_SHADER, fs, name + ':fs');
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`[${name}] link failed: ${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(v); gl.deleteShader(f);
    this.p = p;
    this.u = Object.create(null);
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const nm = info.name.replace(/\[0\]$/, '');
      this.u[nm] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
    this.attribs = Object.create(null);
    const an = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < an; i++) {
      const info = gl.getActiveAttrib(p, i);
      this.attribs[info.name] = gl.getAttribLocation(p, info.name);
    }
    this._unit = 0;
  }
  use() { this.gl.useProgram(this.p); this._unit = 0; return this; }
  set(name, val) {
    const gl = this.gl, e = this.u[name];
    if (!e) return this;
    const t = e.type;
    if (val && val.__tex) {
      const unit = this._unit++;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, val.tex);
      gl.uniform1i(e.loc, unit);
      return this;
    }
    switch (t) {
      case gl.FLOAT: Array.isArray(val) || val instanceof Float32Array ? gl.uniform1fv(e.loc, val) : gl.uniform1f(e.loc, val); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(e.loc, val); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(e.loc, val); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(e.loc, val); break;
      case gl.INT: case gl.BOOL: gl.uniform1i(e.loc, val); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(e.loc, false, val); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(e.loc, false, val); break;
      default: break;
    }
    return this;
  }
  setAll(obj) { for (const k in obj) this.set(k, obj[k]); return this; }
}

function compile(gl, type, src, tag) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
    throw new Error(`[${tag}] ${log}\n${lines}`);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Mesh: VAO + attribute buffers (+ optional per-instance attributes)   */
/* ------------------------------------------------------------------ */
export class Mesh {
  /* attrs: { name: {data:Float32Array, size:n, divisor?:0|1, dynamic?:bool} } */
  constructor(gl, attrs, index = null, mode = null) {
    this.gl = gl;
    this.mode = mode === null ? gl.TRIANGLES : mode;
    this.vao = gl.createVertexArray();
    this.buffers = Object.create(null);
    this.attrs = attrs;
    gl.bindVertexArray(this.vao);
    let count = 0;
    this._locs = Object.create(null);
    this._pending = [];
    for (const name in attrs) {
      const a = attrs[name];
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, a.data, a.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      this.buffers[name] = buf;
      if (!a.divisor) count = Math.max(count, a.data.length / a.size);
      this._pending.push({ name, a, buf });
    }
    if (index) {
      this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
      this.indexCount = index.length;
      this.indexType = index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    } else { this.ibo = null; this.indexCount = 0; }
    gl.bindVertexArray(null);
    this.vertexCount = count;
    this.instanceCount = 0;
    this._boundProgram = null;
  }
  /* bind attribute locations lazily for a given program (locations are program-specific) */
  bindFor(prog) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this._boundProgram === prog.p) return;
    if (this.ibo) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    for (const { name, a, buf } of this._pending) {
      const loc = prog.attribs[name];
      if (loc === undefined || loc < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      if (a.size <= 4) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, a.size, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(loc, a.divisor || 0);
      } else { /* mat4 as 4 vec4 */
        for (let i = 0; i < 4; i++) {
          gl.enableVertexAttribArray(loc + i);
          gl.vertexAttribPointer(loc + i, 4, gl.FLOAT, false, 64, i * 16);
          gl.vertexAttribDivisor(loc + i, a.divisor || 0);
        }
      }
    }
    this._boundProgram = prog.p;
  }
  update(name, data, count) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[name]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, count === undefined ? data : data.subarray(0, count));
  }
  draw(prog, instances = 0, count = -1, offset = 0) {
    const gl = this.gl;
    this.bindFor(prog);
    const n = count < 0 ? (this.ibo ? this.indexCount : this.vertexCount) : count;
    if (n <= 0) return;
    if (this.ibo) {
      const bs = this.indexType === gl.UNSIGNED_INT ? 4 : 2;
      if (instances > 0) gl.drawElementsInstanced(this.mode, n, this.indexType, offset * bs, instances);
      else gl.drawElements(this.mode, n, this.indexType, offset * bs);
    } else {
      if (instances > 0) gl.drawArraysInstanced(this.mode, offset, n, instances);
      else gl.drawArrays(this.mode, offset, n);
    }
  }
  dispose() {
    const gl = this.gl;
    for (const k in this.buffers) gl.deleteBuffer(this.buffers[k]);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
  }
}

export function meshFromGeometry(gl, geo) {
  const attrs = { aPos: { data: geo.position, size: 3 } };
  if (geo.normal) attrs.aNormal = { data: geo.normal, size: 3 };
  if (geo.uv) attrs.aUv = { data: geo.uv, size: 2 };
  if (geo.aux) attrs.aAux = { data: geo.aux, size: 3 };
  return new Mesh(gl, attrs, geo.index || null);
}

/* ------------------------------------------------------------------ */
/* Render target                                                        */
/* ------------------------------------------------------------------ */
export class RenderTarget {
  constructor(gl, w, h, { float = false, depth = false, filter = null } = {}) {
    this.gl = gl; this.w = w | 0; this.h = h | 0; this.float = float; this.hasDepth = depth;
    this.filterMode = filter;
    this.fbo = gl.createFramebuffer();
    this.tex = gl.createTexture();
    this.color = { __tex: true, tex: this.tex };
    this._alloc();
  }
  _alloc() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const internal = this.float ? gl.RGBA16F : gl.RGBA8;
    const type = this.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.w, this.h, 0, gl.RGBA, type, null);
    const f = this.filterMode === null ? gl.LINEAR : this.filterMode;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (this.hasDepth) {
      if (!this.rbo) this.rbo = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbo);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.w, this.h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  resize(w, h) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h; this._alloc();
  }
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
  }
}

/* fullscreen triangle */
export function fullscreenMesh(gl) {
  return new Mesh(gl, { aPos: { data: new Float32Array([-1, -1, 3, -1, -1, 3]), size: 2 } });
}

export const FS_VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

/* ------------------------------------------------------------------ */
/* Context bootstrap                                                    */
/* ------------------------------------------------------------------ */
export function createContext(canvas) {
  const opts = { antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false };
  const gl = canvas.getContext('webgl2', opts);
  if (!gl) return null;
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.clearColor(0, 0, 0, 1);
  return gl;
}
