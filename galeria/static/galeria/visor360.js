// Visor de fotos 360 (equirectangulares) con WebGL2: vista normal, gran angular, mini mundo y bola de cristal.
// Todas las vistas son la misma proyección "perspectiva general": el centro de proyección se ubica a una
// distancia d detrás del centro de la esfera (d = 0 rectilínea, d = 1 estereográfica = mini mundo).
(function () {
  "use strict";

  const RAD = Math.PI / 180;

  // fov: ángulo sobre el lado corto de la pantalla.
  const MODOS = {
    normal: { d: 0, fov: 75, min: 25, max: 110, pitch: null },
    angular: { d: 0.6, fov: 150, min: 90, max: 200, pitch: null },
    planeta: { d: 1, fov: 230, min: 140, max: 310, pitch: -90 },
    cristal: { d: 1, fov: 230, min: 140, max: 310, pitch: 90 },
  };

  const VS = `#version 300 es
  in vec2 p; out vec2 ndc;
  void main() { ndc = p; gl_Position = vec4(p, 0.0, 1.0); }`;

  const FS = `#version 300 es
  precision highp float;
  in vec2 ndc; out vec4 color;
  uniform sampler2D img;
  uniform mat3 M;       // cámara -> mundo
  uniform vec2 k;       // medio ancho/alto del plano de proyección
  uniform float d;
  const float PI = 3.14159265358979;
  void main() {
    vec3 q = vec3(ndc * k, 1.0 + d);
    float qq = dot(q, q);
    float b = d * (1.0 + d);
    float t = (b + sqrt(max(b * b - qq * (d * d - 1.0), 0.0))) / qq;
    vec3 v = M * normalize(vec3(0.0, 0.0, -d) + t * q);
    float lon = atan(v.x, v.z);
    float lat = asin(clamp(v.y, -1.0, 1.0));
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
    // La costura de atrás (lon = ±180°) salta de 1 a 0: las derivadas se toman de una u corrida.
    vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
    vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
    if (abs(dx2.x) < abs(dx.x)) dx.x = dx2.x;
    if (abs(dy2.x) < abs(dy.x)) dy.x = dy2.x;
    color = vec4(textureGrad(img, uv, dx, dy).rgb, 1.0);
  }`;

  function matCamara(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // Ry(yaw) · Rx(pitch): yaw positivo mira a la derecha, pitch positivo mira hacia arriba.
    return mul3([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], [[1, 0, 0], [0, cp, sp], [0, -sp, cp]]);
  }

  function mul3(a, b) {
    return a.map((f) => [0, 1, 2].map((j) => f[0] * b[0][j] + f[1] * b[1][j] + f[2] * b[2][j]));
  }

  // Orientación del teléfono (como DeviceOrientationControls de three.js), pasada a este sistema
  // (x derecha, y arriba, z adelante).
  function matDispositivo(alpha, beta, gamma, pantalla) {
    const rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
    const ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
    const rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
    let m = mul3(mul3(ry(alpha), rx(beta)), rz(-gamma));
    m = mul3(mul3(m, rx(-Math.PI / 2)), rz(-pantalla));
    const f = [[1, 0, 0], [0, 1, 0], [0, 0, -1]];
    return mul3(mul3(f, m), f);
  }

  class Visor {
    constructor(contenedor, opciones) {
      this.el = contenedor;
      this.canvas = document.createElement("canvas");
      this.el.appendChild(this.canvas);
      const gl = this.canvas.getContext("webgl2", { antialias: false });
      if (!gl) throw new Error("Este navegador no puede mostrar fotos 360 (falta WebGL2).");
      this.gl = gl;
      this.yaw = 0;
      this.pitch = 0;
      this.modo = "normal";
      this.d = 0;
      this.fov = MODOS.normal.fov;
      this.anim = null;
      this.giro = null;
      this.autoRotar = opciones.autoRotar !== false;
      this.ultimaInteraccion = 0;
      this.alCambiarModo = opciones.alCambiarModo || (() => {});
      this._programa();
      this._eventos();
      this._redimensionar();
      new ResizeObserver(() => this._redimensionar()).observe(this.el);
      requestAnimationFrame((t) => this._cuadro(t));
    }

    _programa() {
      const gl = this.gl;
      const sh = (tipo, src) => {
        const s = gl.createShader(tipo);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      gl.useProgram(p);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = { M: gl.getUniformLocation(p, "M"), k: gl.getUniformLocation(p, "k"), d: gl.getUniformLocation(p, "d") };
      this.tex = gl.createTexture();
    }

    maxTextura() {
      return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    }

    async cargar(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error("No se pudo cargar la foto.");
      const bmp = await createImageBitmap(await r.blob());
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      bmp.close();
      this.cargada = true;
    }

    // ----- Modos y zoom -----
    cambiarModo(nombre) {
      const m = MODOS[nombre];
      if (!m) return;
      this.modo = nombre;
      this._animar({ d: m.d, fov: m.fov, pitch: m.pitch === null ? Math.max(-30, Math.min(30, this.pitch)) : m.pitch });
      this.alCambiarModo(nombre);
      this._tocar();
    }

    zoom(factor) {
      const m = MODOS[this.modo];
      const destino = Math.max(m.min, Math.min(m.max, (this.anim ? this.anim.hasta.fov : this.fov) * factor));
      this._animar({ fov: destino }, 250);
      this._tocar();
    }

    _animar(hasta, ms = 700) {
      const desde = { d: this.d, fov: this.fov, pitch: this.pitch };
      this.anim = { desde, hasta: { ...desde, ...hasta }, t0: performance.now(), ms };
    }

    // ----- Giroscopio -----
    async activarGiro() {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        if ((await DeviceOrientationEvent.requestPermission()) !== "granted") return false;
      }
      this.giro = { offset: null, m: null };
      this._alOrientar = (e) => {
        if (e.alpha === null) return;
        const pantalla = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * RAD;
        this.giro.m = matDispositivo(e.alpha * RAD, e.beta * RAD, e.gamma * RAD, pantalla);
      };
      window.addEventListener("deviceorientation", this._alOrientar);
      if (this.modo !== "normal") this.cambiarModo("normal");
      return true;
    }

    desactivarGiro() {
      if (!this.giro) return;
      window.removeEventListener("deviceorientation", this._alOrientar);
      const m = this._matriz();
      this.yaw = Math.atan2(m[0][2], m[2][2]);
      this.pitch = Math.asin(Math.max(-1, Math.min(1, m[1][2]))) / RAD;
      this.giro = null;
    }

    _matriz() {
      if (this.giro && this.giro.m) {
        const g = this.giro.m;
        if (this.giro.offset === null) {
          // Que al activar se siga mirando hacia donde se miraba.
          this.giro.offset = this.yaw - Math.atan2(g[0][2], g[2][2]);
        }
        const o = this.giro.offset;
        return mul3([[Math.cos(o), 0, Math.sin(o)], [0, 1, 0], [-Math.sin(o), 0, Math.cos(o)]], g);
      }
      return matCamara(this.yaw, this.pitch * RAD);
    }

    // ----- Interacción -----
    _tocar() {
      this.ultimaInteraccion = performance.now();
    }

    _eventos() {
      const c = this.canvas;
      const punteros = new Map();
      let pinch = null;
      c.style.touchAction = "none";
      c.addEventListener("pointerdown", (e) => {
        c.setPointerCapture(e.pointerId);
        punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (punteros.size === 2) {
          const [a, b] = [...punteros.values()];
          pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), fov: this.fov };
        }
        this._tocar();
      });
      c.addEventListener("pointermove", (e) => {
        const p = punteros.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;
        if (punteros.size === 2 && pinch) {
          const [a, b] = [...punteros.values()];
          const m = MODOS[this.modo];
          this.fov = Math.max(m.min, Math.min(m.max, pinch.fov * pinch.dist / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))));
          this.anim = null;
        } else if (punteros.size === 1 && !this.giro) {
          // Arrastrar mueve la imagen con el dedo, más lento cuando hay zoom.
          const grados = this._fovEfectivo() / Math.min(this.canvas.clientWidth, this.canvas.clientHeight);
          this.yaw -= dx * grados * RAD;
          this.pitch = Math.max(-90, Math.min(90, this.pitch + dy * grados));
          if (this.anim) this.anim.hasta.pitch = this.pitch;
        }
        this._tocar();
      });
      const soltar = (e) => {
        punteros.delete(e.pointerId);
        if (punteros.size < 2) pinch = null;
      };
      c.addEventListener("pointerup", soltar);
      c.addEventListener("pointercancel", soltar);
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12);
      }, { passive: false });
      c.addEventListener("dblclick", () => this.zoom(0.6));
    }

    _fovEfectivo() {
      // Grados de escena por pixel aproximados según el modo.
      return this.d > 0.5 ? this.fov / 3 : this.fov;
    }

    _redimensionar() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.el.clientWidth, h = this.el.clientHeight;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
    }

    _cuadro(t) {
      requestAnimationFrame((t2) => this._cuadro(t2));
      if (this.anim) {
        const a = this.anim;
        const x = Math.min(1, (t - a.t0) / a.ms);
        const e = x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
        for (const clave of ["d", "fov", "pitch"]) this[clave] = a.desde[clave] + (a.hasta[clave] - a.desde[clave]) * e;
        if (x >= 1) this.anim = null;
      }
      if (this.autoRotar && !this.giro && t - this.ultimaInteraccion > 4000) this.yaw += 0.00025 * 16;
      if (!this.cargada) return;

      const gl = this.gl;
      const W = this.canvas.width, H = this.canvas.height;
      gl.viewport(0, 0, W, H);
      // El fov se reparte sobre el lado corto; no puede pasar el límite de la proyección.
      const limite = 2 * Math.acos(-this.d) / RAD - 2;
      const mitad = (Math.min(this.fov, limite) / 2) * RAD;
      const kCorto = ((1 + this.d) * Math.sin(mitad)) / (this.d + Math.cos(mitad));
      const kx = W >= H ? kCorto * (W / H) : kCorto;
      const ky = W >= H ? kCorto : kCorto * (H / W);
      gl.uniform2f(this.u.k, kx, ky);
      gl.uniform1f(this.u.d, this.d);
      gl.uniformMatrix3fv(this.u.M, true, new Float32Array(this._matriz().flat()));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  window.Visor360 = Visor;
})();
