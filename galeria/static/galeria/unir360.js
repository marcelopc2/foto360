// Une un .insp de la Insta360 X5 (dos ojos de pez) en una foto 360 equirectangular,
// en el navegador y con la GPU. Es la misma matemática que galeria/unir.py (allá está explicada).
// Uso: const jpg = await unirInsp(file);  // Blob image/jpeg 2:1
(function () {
  "use strict";

  const MAGIA = "8db42d694ccc418790edff439fe026bf";
  const MUESTRAS_NIVEL = 200;
  const FEATHER = (2 * Math.PI) / 180; // media franja de mezcla alrededor de la línea de corte
  // Paralaje: los lentes están ~3 cm separados. Se prueban distancias (como 1/d, de infinito a 50 cm)
  // y en cada ángulo de la costura se usa la que mejor calza. Igual que en unir.py.
  const INV_D = Array.from({ length: 21 }, (_, i) => i * 0.1);
  const N_PHI = 720;
  const N_TH = 24; // filas de la franja de solape, de 84° a 96°
  const FILA_MIN = 4, FILA_MAX = N_TH - 5; // dónde puede ir la línea de corte (86°–94°)

  function leerCalibracion(texto) {
    const m = texto.match(/2_2\.000000_[-0-9._]+/);
    if (!m) throw new Error("sin calibración");
    const v = m[0].split("_").slice(1).map(Number);
    if (v.length < 38) throw new Error("calibración incompleta");
    return [0, 1].map((i) => {
      const p = v.slice(i * 19, (i + 1) * 19);
      const rad = (x) => (x * Math.PI) / 180;
      return {
        xi: p[0], fx: p[1], fy: p[2], cx: p[3], cy: p[4],
        ypr: [rad(p[5]), rad(p[6]), rad(p[7])], t: p.slice(8, 11), k: p.slice(11, 14), p: p.slice(14, 16), w: p[16],
      };
    });
  }

  function leerGravedad(buf, texto) {
    const n = buf.byteLength;
    if (texto.slice(n - 32) !== MAGIA) return null;
    const dv = new DataView(buf);
    const total = dv.getUint32(n - 40, true);
    let off = 72;
    while (off < total) {
      const rid = dv.getUint8(n - off - 5);
      const tam = dv.getUint32(n - off - 4, true);
      if (tam <= 0 || tam > n - off - 6) break;
      if (rid === 0x03 && tam % 20 === 0) {
        const ini = n - off - 6 - tam;
        const s = [0, 0, 0];
        let c = 0;
        for (let i = 0; i < Math.min(MUESTRAS_NIVEL, tam / 20); i++) {
          const b = ini + i * 20 + 8;
          const a = [0, 1, 2].map((j) => dv.getUint16(b + j * 2, true) - 32768);
          const norma = Math.hypot(a[0], a[1], a[2]);
          if (norma <= 1) continue;
          for (let j = 0; j < 3; j++) s[j] += a[j] / norma;
          c++;
        }
        if (!c) return null;
        const g = [-s[2], -s[0], s[1]];
        const ng = Math.hypot(g[0], g[1], g[2]);
        return g.map((x) => x / ng);
      }
      off += tam + 6;
    }
    return null;
  }

  // Matrices 3x3 como arreglos de filas.
  const mul = (a, b) => a.map((fila) => [0, 1, 2].map((j) => fila[0] * b[0][j] + fila[1] * b[1][j] + fila[2] * b[2][j]));

  function rot(yaw, pitch, roll) {
    const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
    const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
    const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
    const rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
    return mul(mul(rz, rx), ry);
  }

  function alinear(b) {
    // Rotación mínima que lleva (0,1,0) hacia b.
    const v = [b[2], 0, -b[0]]; // (0,1,0) x b
    const c = b[1];
    if (c < -0.9999) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
    const k = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]];
    const k2 = mul(k, k);
    return [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) + k[i][j] + k2[i][j] / (1 + c)));
  }

  const VS = `#version 300 es
  in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

  const FS = `#version 300 es
  precision highp float;
  uniform sampler2D img;
  uniform vec2 salida;
  uniform float fila0;
  uniform float calW, calH;
  uniform mat3 N;            // nivelación: mundo -> cámara
  uniform mat3 R[2];         // cámara -> cada lente
  uniform vec3 T[2], G[2];   // posición de cada lente (m) y ganancia de color
  uniform sampler2D tInv;    // por ángulo de la costura (N_PHI x 1): r = 1/distancia, g = θ de la línea de corte
  uniform int modo;          // 0: foto final; 1: franja de la costura en gris; 2: franja en color
  uniform float invFijo;
  uniform float xi[2], fx[2], fy[2], cx[2], cy[2], k1[2], k2[2], k3[2], p1[2], p2[2];
  out vec4 color;
  const float PI = 3.14159265358979;
  const float FEATHER = ${FEATHER.toFixed(8)};

  const float N_PHI = ${N_PHI}.0;
  const int N_TH = ${N_TH};

  // db: dirección en el sistema de la cámara; iv: 1/distancia del punto que se mira.
  vec4 lente(int i, vec3 db, float iv) {
    vec3 d = R[i] * normalize(db - iv * T[i]);
    float den = d.z + xi[i];
    float mx = d.x / den, my = d.y / den;
    float r2 = mx * mx + my * my;
    float rad = 1.0 + k1[i] * r2 + k2[i] * r2 * r2 + k3[i] * r2 * r2 * r2;
    float dx = mx * rad + 2.0 * p1[i] * mx * my + p2[i] * (r2 + 2.0 * mx * mx);
    float dy = my * rad + p1[i] * (r2 + 2.0 * my * my) + 2.0 * p2[i] * mx * my;
    vec2 uv = vec2((fx[i] * dx + cx[i]) / calW, (fy[i] * dy + cy[i]) / calH);
    return vec4(texture(img, uv).rgb, 1.0);
  }

  vec2 costuraEn(vec3 db) {
    float pos = mod((atan(db.y, db.x) + PI) / (2.0 * PI) * N_PHI - 0.5, N_PHI);
    int i0 = int(floor(pos));
    vec2 a = texelFetch(tInv, ivec2(i0, 0), 0).rg;
    vec2 b = texelFetch(tInv, ivec2((i0 + 1) % int(N_PHI), 0), 0).rg;
    return mix(a, b, fract(pos));
  }

  void main() {
    if (modo != 0) {
      // Franja de la costura: x = ángulo, filas 0..N_TH-1 lente 1, N_TH..2*N_TH-1 lente 2.
      int fila = int(gl_FragCoord.y);
      int i = fila / N_TH;
      float th = radians(84.0 + 12.0 * float(fila % N_TH) / float(N_TH - 1));
      float phi = gl_FragCoord.x / N_PHI * 2.0 * PI - PI;
      vec3 db = vec3(sin(th) * cos(phi), sin(th) * sin(phi), cos(th));
      vec3 c = lente(i, db, invFijo).rgb;
      color = modo == 1 ? vec4(vec3(dot(c, vec3(0.299, 0.587, 0.114))), 1.0) : vec4(c, 1.0);
      return;
    }
    // Se dibuja por franjas; readPixels entrega la fila 0 primero, así que fila 0 = arriba de la franja.
    vec2 px = vec2(gl_FragCoord.x, fila0 + gl_FragCoord.y);
    float lon = px.x / salida.x * 2.0 * PI - PI;
    float lat = PI / 2.0 - px.y / salida.y * PI;
    vec3 db = N * vec3(cos(lat) * sin(lon), -sin(lat), cos(lat) * cos(lon));
    vec2 c = costuraEn(db);
    float iv = c.r * (1.0 - db.z * db.z);  // se desvanece hacia el centro de cada lente
    // Peso del lente frontal: 1 antes de la línea de corte, 0 después, con mezcla corta.
    float w1 = clamp((c.g + FEATHER - acos(clamp(db.z, -1.0, 1.0))) / (2.0 * FEATHER), 0.0, 1.0);
    vec3 a = lente(0, db, iv).rgb;
    vec3 b = lente(1, db, iv).rgb;
    color = vec4(a * G[0] * w1 + b * G[1] * (1.0 - w1), 1.0);
  }`;

  // Dibuja la franja de la costura (N_PHI x 2·N_TH) con una distancia fija y la devuelve en RGBA.
  function leerBanda(gl, u, modo, invFijo) {
    const ancho = N_PHI, alto = 2 * N_TH;
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, ancho, alto);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    gl.viewport(0, 0, ancho, alto);
    gl.uniform1i(u("modo"), modo);
    gl.uniform1f(u("invFijo"), invFijo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(ancho * alto * 4);
    gl.readPixels(0, 0, ancho, alto, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteRenderbuffer(rb);
    return px;
  }

  const suavizarCircular = (f, r) => Float64Array.from(f, (_, j) => {
    let t = 0;
    for (let d = -r; d <= r; d++) t += f[(j + d + f.length) % f.length];
    return t / (2 * r + 1);
  });

  function gaussCircular(f, sigma) {
    const r = Math.ceil(3 * sigma);
    const g = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-0.5 * ((i - r) / sigma) ** 2));
    const sg = g.reduce((a, b) => a + b);
    return Float32Array.from(f, (_, j) => g.reduce((acc, w, i) => acc + w * f[(j + i - r + f.length) % f.length], 0) / sg);
  }

  // Por cada ángulo de la costura: la distancia que mejor calza ambos lentes y dónde poner la línea de corte.
  function buscarCostura(gl, u) {
    const n = N_PHI * N_TH;
    const difs = INV_D.map((iv) => {
      const px = leerBanda(gl, u, 1, iv);
      let ma = 0, mb = 0;
      for (let k = 0; k < n; k++) { ma += px[k * 4]; mb += px[(n + k) * 4]; }
      ma /= n;
      mb /= n;
      const d = new Float32Array(n); // fila θ, columna φ
      for (let k = 0; k < n; k++) d[k] = Math.abs(px[k * 4] - ma - (px[(n + k) * 4] - mb));
      return d;
    });

    // 1) Distancia: error promedio en toda la franja, por ángulo.
    const costoD = difs.map((d) => {
      const c = new Float64Array(N_PHI);
      for (let f = 0; f < N_TH; f++) for (let j = 0; j < N_PHI; j++) c[j] += d[f * N_PHI + j] / N_TH;
      return suavizarCircular(c, 4);
    });
    const k = camino(costoD, 0.15);
    const inv = gaussCircular(Float64Array.from(k, (q) => INV_D[q]), 3);

    // 2) Línea de corte: dentro del solape, por donde ambos lentes más coinciden a esa distancia.
    const filas = FILA_MAX - FILA_MIN + 1;
    const costoF = Array.from({ length: filas }, (_, r) => {
      const c = new Float64Array(N_PHI);
      for (let j = 0; j < N_PHI; j++) {
        let t = 0;
        for (let df = -3; df <= 3; df++) {
          const f = Math.min(N_TH - 1, Math.max(0, FILA_MIN + r + df));
          t += difs[k[j]][f * N_PHI + j];
        }
        c[j] = t / 7;
      }
      return suavizarCircular(c, 4);
    });
    const fila = camino(costoF, 0.3);
    const corte = gaussCircular(Float64Array.from(fila, (r) => (84 + (12 * (FILA_MIN + r)) / (N_TH - 1)) * Math.PI / 180), 2);
    return { inv, corte };
  }

  // Programación dinámica sobre el círculo de la costura: un índice por ángulo, sin saltos bruscos.
  function camino(costos, lamRel) {
    const K = costos.length, n = N_PHI;
    const todos = costos.flatMap((f) => Array.from(f)).sort((a, b) => a - b);
    const lam = lamRel * todos[Math.floor(todos.length / 2)] + 1e-6;
    const largo = 3 * n; // 3 vueltas y se usa la del medio
    let acum = Float64Array.from({ length: K }, (_, q) => costos[q][0]);
    const desde = new Int32Array(largo * K);
    for (let j = 1; j < largo; j++) {
      const nuevo = new Float64Array(K);
      for (let q = 0; q < K; q++) {
        let mejor = Infinity, arg = 0;
        for (let p = 0; p < K; p++) {
          const v = acum[p] + lam * Math.abs(q - p);
          if (v < mejor) { mejor = v; arg = p; }
        }
        desde[j * K + q] = arg;
        nuevo[q] = mejor + costos[q][j % n];
      }
      acum = nuevo;
    }
    const idx = new Int32Array(largo);
    idx[largo - 1] = acum.indexOf(Math.min(...acum));
    for (let j = largo - 1; j > 0; j--) idx[j - 1] = desde[j * K + idx[j]];
    return idx.slice(n, 2 * n);
  }

  function medirGanancias(gl, u, invFijo) {
    const px = leerBanda(gl, u, 2, invFijo);
    const n = N_PHI * N_TH;
    const m = [[1, 1, 1], [1, 1, 1]];
    for (let k = 0; k < 2 * n; k++) for (let ch = 0; ch < 3; ch++) m[k < n ? 0 : 1][ch] += px[k * 4 + ch] / n;
    return [0, 1, 2].map((ch) => Math.min(1.25, Math.max(0.8, Math.sqrt(m[1][ch] / m[0][ch]))));
  }

  const mediana = (a) => Array.from(a).sort((x, y) => x - y)[Math.floor(a.length / 2)];

  function compilar(gl, tipo, src) {
    const s = gl.createShader(tipo);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  async function unirInsp(file, opciones = {}) {
    const buf = await file.arrayBuffer();
    const texto = new TextDecoder("latin1").decode(buf);
    const lentes = leerCalibracion(texto);
    const g = opciones.nivelar === false ? null : leerGravedad(buf, texto);
    const nivel = g ? alinear(g) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

    const gl = document.createElement("canvas").getContext("webgl2", { antialias: false });
    if (!gl) throw new Error("sin WebGL2");
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxVista = Math.min(gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));

    // Los teléfonos tienen límites de memoria para texturas y canvas grandes.
    const movil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
    const tope = Math.min(maxTex, movil ? 5760 : 16384);

    const blob = new Blob([buf], { type: "image/jpeg" });
    let bmp = await createImageBitmap(blob);
    if (bmp.width > tope) {
      const w = tope;
      bmp.close();
      bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: Math.round(w / 2), resizeQuality: "high" });
    }
    let W = Math.min(opciones.ancho || bmp.width, tope, maxVista);
    W -= W % 2;
    const H = W / 2;

    const prog = gl.createProgram();
    gl.attachShader(prog, compilar(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compilar(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, bmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    bmp.close();

    const u = (n) => gl.getUniformLocation(prog, n);
    gl.uniform2f(u("salida"), W, H);
    gl.uniform1f(u("calW"), lentes[0].w);
    gl.uniform1f(u("calH"), lentes[0].w / 2);
    const mats = lentes.map((l, i) => {
      const r = rot(l.ypr[0], -l.ypr[1], l.ypr[2] - Math.PI / 2);
      return i === 1 ? mul(r, [[-1, 0, 0], [0, 1, 0], [0, 0, -1]]) : r; // el lente trasero mira hacia atrás
    });
    gl.uniformMatrix3fv(u("R"), true, new Float32Array(mats.flat(2)));
    gl.uniformMatrix3fv(u("N"), true, new Float32Array(nivel.flat()));
    const medio = [0, 1, 2].map((j) => (lentes[0].t[j] + lentes[1].t[j]) / 2);
    gl.uniform3fv(u("T"), new Float32Array(lentes.flatMap((l) => l.t.map((x, j) => x - medio[j]))));
    const par = (nombre, f) => gl.uniform1fv(u(nombre), new Float32Array(lentes.map(f)));
    par("xi", (l) => l.xi);
    par("fx", (l) => l.fx);
    par("fy", (l) => l.fy);
    par("cx", (l) => l.cx);
    par("cy", (l) => l.cy);
    par("k1", (l) => l.k[0]);
    par("k2", (l) => l.k[1]);
    par("k3", (l) => l.k[2]);
    par("p1", (l) => l.p[0]);
    par("p2", (l) => l.p[1]);

    // Distancia de la costura por ángulo y ganancia de color entre lentes.
    gl.uniform1i(u("img"), 0);
    gl.uniform1i(u("tInv"), 1);
    const costura = opciones.paralaje === false
      ? { inv: new Float32Array(N_PHI), corte: new Float32Array(N_PHI).fill(Math.PI / 2) }
      : buscarCostura(gl, u);
    const inv = costura.inv;
    const ganancia = medirGanancias(gl, u, mediana(inv));
    const rg = new Float32Array(2 * N_PHI);
    for (let j = 0; j < N_PHI; j++) { rg[2 * j] = inv[j]; rg[2 * j + 1] = costura.corte[j]; }
    gl.uniform3fv(u("G"), new Float32Array([...ganancia, ...ganancia.map((x) => 1 / x)]));
    const texInv = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texInv);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, N_PHI, 1, 0, gl.RG, gl.FLOAT, rg);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u("modo"), 0);

    // Chrome achica en silencio los lienzos WebGL de más de ~33 MP, así que se dibuja
    // por franjas en un framebuffer y se arma la foto completa en un canvas 2D.
    const alto = Math.max(1, Math.min(H, Math.floor((1 << 24) / W)));
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, alto);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("framebuffer incompleto");

    const lienzo = document.createElement("canvas");
    lienzo.width = W;
    lienzo.height = H;
    const ctx = lienzo.getContext("2d");
    const pixeles = new Uint8ClampedArray(W * alto * 4);
    gl.viewport(0, 0, W, alto);
    for (let f0 = 0; f0 < H; f0 += alto) {
      const filas = Math.min(alto, H - f0);
      gl.uniform1f(u("fila0"), f0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, W, filas, gl.RGBA, gl.UNSIGNED_BYTE, pixeles);
      ctx.putImageData(new ImageData(pixeles.subarray(0, W * filas * 4), W, filas), 0, f0);
    }
    const err = gl.getError();
    if (err) throw new Error("WebGL error " + err);

    const salida = await new Promise((ok) => lienzo.toBlob(ok, "image/jpeg", 0.92));
    lienzo.width = lienzo.height = 0;
    gl.deleteFramebuffer(fb);
    gl.deleteRenderbuffer(rb);
    gl.deleteTexture(tex);
    gl.deleteTexture(texInv);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (!salida) throw new Error("no se pudo generar el JPG");
    return salida;
  }

  window.unirInsp = unirInsp;
})();
