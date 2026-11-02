// Une un .insp de la Insta360 X5 (dos ojos de pez) en una foto 360 equirectangular,
// en el navegador y con la GPU. Es la misma matemática que galeria/unir.py (allá está explicada).
// Uso: const jpg = await unirInsp(file);  // Blob image/jpeg 2:1
(function () {
  "use strict";

  const MAGIA = "8db42d694ccc418790edff439fe026bf";
  const MUESTRAS_NIVEL = 200;
  const FEATHER = (6 * Math.PI) / 180;

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
        ypr: [rad(p[5]), rad(p[6]), rad(p[7])], k: p.slice(11, 14), p: p.slice(14, 16), w: p[16],
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
  uniform mat3 R[2];
  uniform float xi[2], fx[2], fy[2], cx[2], cy[2], k1[2], k2[2], k3[2], p1[2], p2[2];
  out vec4 color;
  const float PI = 3.14159265358979;
  const float FEATHER = ${FEATHER.toFixed(8)};

  vec4 lente(int i, vec3 dw) {
    vec3 d = R[i] * dw;
    float den = d.z + xi[i];
    float mx = d.x / den, my = d.y / den;
    float r2 = mx * mx + my * my;
    float rad = 1.0 + k1[i] * r2 + k2[i] * r2 * r2 + k3[i] * r2 * r2 * r2;
    float dx = mx * rad + 2.0 * p1[i] * mx * my + p2[i] * (r2 + 2.0 * mx * mx);
    float dy = my * rad + p1[i] * (r2 + 2.0 * my * my) + 2.0 * p2[i] * mx * my;
    vec2 uv = vec2((fx[i] * dx + cx[i]) / calW, (fy[i] * dy + cy[i]) / calH);
    float theta = acos(clamp(d.z, -1.0, 1.0));
    float w = clamp((PI / 2.0 + FEATHER - theta) / (2.0 * FEATHER), 0.0, 1.0);
    return vec4(texture(img, uv).rgb * w, w);
  }

  void main() {
    // Se dibuja por franjas; readPixels entrega la fila 0 primero, así que fila 0 = arriba de la franja.
    vec2 px = vec2(gl_FragCoord.x, fila0 + gl_FragCoord.y);
    float lon = px.x / salida.x * 2.0 * PI - PI;
    float lat = PI / 2.0 - px.y / salida.y * PI;
    vec3 dw = vec3(cos(lat) * sin(lon), -sin(lat), cos(lat) * cos(lon));
    vec4 a = lente(0, dw) + lente(1, dw);
    color = vec4(a.rgb / max(a.a, 1e-6), 1.0);
  }`;

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
      let r = rot(l.ypr[0], -l.ypr[1], l.ypr[2] - Math.PI / 2);
      if (i === 1) r = mul(r, [[-1, 0, 0], [0, 1, 0], [0, 0, -1]]); // el lente trasero mira hacia atrás
      return mul(r, nivel);
    });
    gl.uniformMatrix3fv(u("R"), true, new Float32Array(mats.flat(2)));
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
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (!salida) throw new Error("no se pudo generar el JPG");
    return salida;
  }

  window.unirInsp = unirInsp;
})();
