// Visor de fotos 360 (equirectangulares) con WebGL2.
// Un solo zoom continuo z (0 = muy cerca, 1 = mini mundo) recorre normal -> gran angular -> mini mundo,
// como en la app de Insta360. Las vistas son la proyección "perspectiva general": el centro de proyección
// está a una distancia d detrás del centro de la esfera (d = 0 rectilínea, d = 1 estereográfica).
// Con "Recto" las vistas anchas usan Pannini, que mantiene rectas las líneas verticales.
(function () {
  "use strict";

  const RAD = Math.PI / 180;

  // z -> [fov sobre el lado corto, d]
  const CURVA = [
    [0.0, 25, 0],
    [0.3, 75, 0],
    [0.5, 140, 0.55],
    [0.7, 200, 1],
    [1.0, 300, 1],
  ];
  const MODOS = { normal: 0.3, angular: 0.5, planeta: 0.92, cristal: 0.92 };

  const suave = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function enCurva(z) {
    for (let i = 1; i < CURVA.length; i++) {
      if (z <= CURVA[i][0]) {
        const [z0, f0, d0] = CURVA[i - 1], [z1, f1, d1] = CURVA[i];
        const t = suave(0, 1, (z - z0) / (z1 - z0));
        return { fov: f0 + (f1 - f0) * t, d: d0 + (d1 - d0) * t };
      }
    }
    return { fov: 300, d: 1 };
  }

  const VS = `#version 300 es
  in vec2 p; out vec2 ndc;
  void main() { ndc = p; gl_Position = vec4(p, 0.0, 1.0); }`;

  const FS = `#version 300 es
  precision highp float;
  in vec2 ndc; out vec4 color;
  uniform sampler2D img;
  uniform mat3 M;          // cámara -> mundo
  uniform vec2 kG, kP;     // medio ancho/alto del plano: perspectiva general y Pannini
  uniform float d, dP, mezcla;  // mezcla: 0 = Pannini, 1 = perspectiva general
  uniform float volteo;          // -1 al capturar: readPixels entrega las filas de abajo hacia arriba
  const float PI = 3.14159265358979;

  vec3 general(vec2 s) {
    vec3 q = vec3(s, 1.0 + d);
    float qq = dot(q, q);
    float b = d * (1.0 + d);
    float t = (b + sqrt(max(b * b - qq * (d * d - 1.0), 0.0))) / qq;
    return normalize(vec3(0.0, 0.0, -d) + t * q);
  }

  vec3 pannini(vec2 s) {
    float k = s.x * s.x / ((dP + 1.0) * (dP + 1.0));
    float dscr = k * k * dP * dP - (k + 1.0) * (k * dP * dP - 1.0);
    float clon = (-k * dP + sqrt(max(dscr, 0.0))) / (k + 1.0);
    float S = (dP + 1.0) / (dP + clon);
    float lon = atan(s.x, S * clon);
    float lat = atan(s.y / S);
    return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  }

  void main() {
    vec2 n = vec2(ndc.x, ndc.y * volteo);
    vec3 r = mezcla >= 1.0 ? general(n * kG) : normalize(mix(pannini(n * kP), general(n * kG), mezcla));
    vec3 v = M * r;
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

  function mul3(a, b) {
    return a.map((f) => [0, 1, 2].map((j) => f[0] * b[0][j] + f[1] * b[1][j] + f[2] * b[2][j]));
  }

  function matCamara(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // Ry(yaw) · Rx(pitch): yaw positivo mira a la derecha, pitch positivo mira hacia arriba.
    return mul3([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], [[1, 0, 0], [0, cp, sp], [0, -sp, cp]]);
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
    constructor(contenedor, opciones = {}) {
      this.el = contenedor;
      this.canvas = document.createElement("canvas");
      this.el.appendChild(this.canvas);
      const gl = this.canvas.getContext("webgl2", { antialias: false });
      if (!gl) throw new Error("Este navegador no puede mostrar fotos 360 (falta WebGL2).");
      this.gl = gl;
      this.yaw = 0;
      this.pitchUsuario = 0;
      // Inclinación con el zoom alejado: -90 mira al suelo (mini mundo), +90 al cielo (bola).
      // Como en la app de Insta360, arrastrar en vertical la mueve de un extremo al otro.
      this.pitchLejos = this.pitchLejosDestino = -90;
      this.s = 0;
      this.z = this.zDestino = MODOS.normal;
      this.recto = opciones.recto !== false;
      this.giro = null;
      this.autoRotar = opciones.autoRotar !== false;
      this.ultimaInteraccion = 0;
      this.modoActual = null;
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
      this.u = {};
      for (const n of ["M", "kG", "kP", "d", "dP", "mezcla", "volteo"]) this.u[n] = gl.getUniformLocation(p, n);
      this.tex = gl.createTexture();
    }

    maxTextura() {
      return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    }

    async cargar(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error("No se pudo cargar la foto.");
      const bmp = await createImageBitmap(await r.blob());
      this._subirTextura(this.tex, bmp);
      this.cargada = true;
    }

    _subirTextura(tex, bmp) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, tex);
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
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
    }

    // ----- Zoom continuo y modos -----
    cambiarModo(nombre) {
      if (!(nombre in MODOS)) return;
      if (this.giro && nombre !== "normal") return;
      // Ir al equivalente más cercano (cada 360°) para no dar vueltas de más.
      const cercano = (a) => a + 360 * Math.round((this.pitchLejos - a) / 360);
      if (nombre === "planeta") this.pitchLejosDestino = cercano(-90);
      if (nombre === "cristal") this.pitchLejosDestino = cercano(90);
      this.zDestino = MODOS[nombre];
      this._tocar();
    }

    zoom(delta) {
      // delta > 0 aleja (hacia mini mundo), < 0 acerca.
      let z = Math.min(1, Math.max(0, this.zDestino + delta));
      if (this.giro) z = Math.min(z, 0.4);
      // Al empezar a alejarse más allá del gran angular se decide si sale mini mundo o bola,
      // según si se estaba mirando hacia abajo o hacia arriba.
      if (this.zDestino < 0.45 && z >= 0.45) this.pitchLejos = this.pitchLejosDestino = this.pitchUsuario > 20 ? 90 : -90;
      this.zDestino = z;
      this._tocar();
    }

    ponerRecto(si) {
      this.recto = si;
      this._tocar();
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
      this.zDestino = Math.min(this.zDestino, MODOS.normal);
      return true;
    }

    desactivarGiro() {
      if (!this.giro) return;
      window.removeEventListener("deviceorientation", this._alOrientar);
      const m = this._matriz(0);
      this.yaw = Math.atan2(m[0][2], m[2][2]);
      this.pitchUsuario = Math.asin(Math.max(-1, Math.min(1, m[1][2]))) / RAD;
      this.giro = null;
    }

    _matriz(pitch) {
      if (this.giro && this.giro.m) {
        const g = this.giro.m;
        if (this.giro.offset === null) this.giro.offset = this.yaw - Math.atan2(g[0][2], g[2][2]);
        const o = this.giro.offset;
        return mul3([[Math.cos(o), 0, Math.sin(o)], [0, 1, 0], [-Math.sin(o), 0, Math.cos(o)]], g);
      }
      return matCamara(this.yaw, pitch * RAD);
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
        try { c.setPointerCapture(e.pointerId); } catch (err) { /* puntero ya liberado */ }
        punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.inercia = null; // tocar frena el deslizamiento
        this._vel = { x: 0, y: 0, t: performance.now() };
        if (punteros.size === 2) {
          const [a, b] = [...punteros.values()];
          pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), z: this.zDestino };
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
          const razon = pinch.dist / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
          this.zoom(pinch.z + Math.log(razon) * 0.35 - this.zDestino);
        } else if (punteros.size === 1 && !this.giro) {
          this._mover(dx, dy);
          // Velocidad del dedo (px/ms, suavizada) para seguir deslizando al soltar.
          const ahora = performance.now(), v = this._vel;
          const dt = Math.max(1, ahora - v.t);
          v.x = v.x * 0.6 + (dx / dt) * 0.4;
          v.y = v.y * 0.6 + (dy / dt) * 0.4;
          v.t = ahora;
        }
        this._tocar();
      });
      const soltar = (e) => {
        const eraArrastre = punteros.size === 1 && !pinch;
        punteros.delete(e.pointerId);
        if (punteros.size < 2) pinch = null;
        // Al soltar, la imagen sigue un poco y se frena de a poco (si el dedo venía moviéndose).
        const v = this._vel;
        if (eraArrastre && v && performance.now() - v.t < 80 && Math.hypot(v.x, v.y) > 0.05 && !this.giro) {
          this.inercia = { x: v.x, y: v.y };
        }
      };
      c.addEventListener("pointerup", soltar);
      c.addEventListener("pointercancel", soltar);
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        const paso = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.zoom(Math.max(-0.08, Math.min(0.08, paso * 0.0005)));
      }, { passive: false });
      c.addEventListener("dblclick", () => this.zoom(-0.12));
    }

    // Mueve la vista como si se arrastrara dx, dy pixeles (más lento cuando hay zoom).
    _mover(dx, dy) {
      const c = this.canvas;
      const { fov, d } = enCurva(this.z);
      const lado = Math.min(c.clientWidth, c.clientHeight);
      const grados = (d > 0.5 ? fov / 3 : fov) / lado;
      this.yaw -= dx * grados * RAD;
      if (this.s > 0.5) {
        // Alejado: el arrastre vertical inclina sin tope (media pantalla ≈ 90°): del mini mundo
        // pasa por el horizonte a la bola y, si se sigue, el planeta rueda y muestra el otro lado.
        this.pitchLejos = this.pitchLejosDestino = this.pitchLejosDestino + dy * 180 / lado;
      } else {
        this.pitchUsuario = Math.max(-90, Math.min(90, this.pitchUsuario + dy * grados));
      }
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
      const dt = Math.min(64, t - (this._t || t));
      this._t = t;
      // El zoom sigue a su destino con suavidad (rueda, botones y modos).
      this.z += (this.zDestino - this.z) * (1 - Math.exp(-dt / 90));
      if (Math.abs(this.zDestino - this.z) < 1e-4) this.z = this.zDestino;
      if (this.inercia) {
        this._mover(this.inercia.x * dt, this.inercia.y * dt);
        const roce = Math.exp(-dt / 320);
        this.inercia.x *= roce;
        this.inercia.y *= roce;
        if (Math.hypot(this.inercia.x, this.inercia.y) < 0.01) this.inercia = null;
        this._tocar();
      }
      if (this.autoRotar && !this.giro && t - this.ultimaInteraccion > 4000) this.yaw += 0.00025 * dt;

      this.pitchLejos += (this.pitchLejosDestino - this.pitchLejos) * (1 - Math.exp(-dt / 90));
      // Mantener la inclinación a menos de media vuelta de la del modo normal (360° es la misma vista),
      // así al acercarse vuelve por el camino corto.
      const vuelta = 360 * Math.round((this.pitchLejos - this.pitchUsuario) / 360);
      this.pitchLejos -= vuelta;
      this.pitchLejosDestino -= vuelta;
      const arriba = Math.sin(this.pitchLejosDestino * RAD) > 0;
      const modo = this.zDestino < 0.42 ? "normal" : this.zDestino < 0.7 ? "angular" : arriba ? "cristal" : "planeta";
      if (modo !== this.modoActual) {
        this.modoActual = modo;
        this.alCambiarModo(modo);
      }
      if (!this.cargada) return;

      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this._dibujar(this.canvas.width, this.canvas.height, 1, 1, 1);
    }

    // Dibuja la vista actual. W x H: tamaño de la pantalla (define la proporción);
    // fx, fy: fracción de la pantalla que se dibuja (el encuadre, centrado).
    _dibujar(W, H, fx, fy, volteo) {
      const { fov, d } = enCurva(this.z);
      // Al alejarse, la vista gira sola hacia el suelo (mini mundo) o el cielo (bola).
      const s = (this.s = suave(0.42, 0.72, this.z));
      const pitch = this.pitchUsuario + (this.pitchLejos - this.pitchUsuario) * s;
      const mezcla = this.recto ? suave(0.45, 0.72, this.z) : 1;
      const dP = suave(0.15, 0.5, this.z);

      const gl = this.gl;
      const ancho = W >= H;
      // Perspectiva general: el fov se reparte sobre el lado corto, sin pasar el límite de la proyección.
      const lim = 2 * Math.acos(-d) / RAD - 2;
      const m = (Math.min(fov, lim) / 2) * RAD;
      const kc = ((1 + d) * Math.sin(m)) / (d + Math.cos(m));
      gl.uniform2f(this.u.kG, (ancho ? kc * W / H : kc) * fx, (ancho ? kc : kc * H / W) * fy);
      // Pannini: mismo fov sobre el lado corto (vertical: tangente; horizontal: fórmula de Pannini).
      const mp = (Math.min(fov, 150) / 2) * RAD;
      if (ancho) {
        const ky = Math.tan(mp);
        gl.uniform2f(this.u.kP, ky * W / H * fx, ky * fy);
      } else {
        const kx = ((dP + 1) * Math.sin(mp)) / (dP + Math.cos(mp));
        gl.uniform2f(this.u.kP, kx * fx, kx * H / W * fy);
      }
      gl.uniform1f(this.u.d, d);
      gl.uniform1f(this.u.dP, dP);
      gl.uniform1f(this.u.mezcla, mezcla);
      gl.uniform1f(this.u.volteo, volteo);
      gl.uniformMatrix3fv(this.u.M, true, new Float32Array(this._matriz(pitch).flat()));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ----- Captura -----
    // Foto plana de lo que está dentro del encuadre (fracción fx, fy de la pantalla, centrado).
    // `urlAlta`: la foto original, para que la captura salga con todo el detalle si la GPU la aguanta.
    async capturar({ fx, fy, ladoLargo = 4096, urlAlta = null, anchoAlta = 0 }) {
      const gl = this.gl;
      const maxRB = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
      const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      const proporcion = (fx * cw) / (fy * ch);
      const largo = Math.min(ladoLargo, maxRB);
      const W = Math.round(proporcion >= 1 ? largo : largo * proporcion);
      const H = Math.round(proporcion >= 1 ? largo / proporcion : largo);

      if (urlAlta && !this.texAlta && anchoAlta && anchoAlta <= this.maxTextura()) {
        try {
          const bmp = await createImageBitmap(await (await fetch(urlAlta)).blob());
          this.texAlta = gl.createTexture();
          this._subirTextura(this.texAlta, bmp);
        } catch (e) {
          this.texAlta = null; // se captura con la vista normal
        }
      }

      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      gl.viewport(0, 0, W, H);
      if (this.texAlta) gl.bindTexture(gl.TEXTURE_2D, this.texAlta);
      this._dibujar(cw, ch, fx, fy, -1);
      const px = new Uint8ClampedArray(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteRenderbuffer(rb);

      const lienzo = document.createElement("canvas");
      lienzo.width = W;
      lienzo.height = H;
      lienzo.getContext("2d").putImageData(new ImageData(px, W, H), 0, 0);
      const blob = await new Promise((ok) => lienzo.toBlob(ok, "image/jpeg", 0.92));
      lienzo.width = lienzo.height = 0;
      if (!blob) throw new Error("No se pudo generar la foto.");
      return blob;
    }
  }

  window.Visor360 = Visor;
})();
