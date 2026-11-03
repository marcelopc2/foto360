"""Une los dos ojos de pez de un .insp (Insta360 X5) en una foto 360 equirectangular.

El .insp es un JPEG con los dos lentes lado a lado. Al final trae un "trailer" de Insta360
con registros (calibración, acelerómetro, etc.). De ahí sacamos:

- Calibración de cada lente, como texto:
    2_<xi>_<fx>_<fy>_<cx>_<cy>_<yaw>_<pitch>_<roll>_<tx>_<ty>_<tz>_<k1>_<k2>_<k3>_<p1>_<p2>_<w>_<h>_<?>_<lente 2...>
  Es el modelo omnidireccional de Mei (proyección unificada + distorsión radial/tangencial),
  medido sobre una imagen de <w>x<h>; se escala al tamaño real del JPEG.
- Acelerómetro (registro 0x03): para nivelar el horizonte como hace Insta360 Studio.
"""
import re
import struct

import cv2
import numpy as np

PATRON = re.compile(rb"2_2\.000000_[-0-9._]+")
MAGIA = b"8db42d694ccc418790edff439fe026bf"  # fin del trailer Insta360
FEATHER = np.radians(2)  # media franja de mezcla alrededor de la línea de corte
# Paralaje: los lentes están ~3 cm separados, así que lo cercano no calza a la misma distancia
# en toda la costura. Se prueba cada distancia (como 1/d) y se elige la que mejor calza por ángulo.
INV_D = np.linspace(0, 2.0, 21)  # infinito .. 50 cm
N_PHI = 720  # ángulos a lo largo de la costura (cada 0,5°)
N_TH = 24  # filas de la franja de solape, de 84° a 96°
TH_BANDA = np.linspace(84, 96, N_TH)
FILAS_CORTE = range(4, N_TH - 4)  # dónde puede ir la línea de corte (86°–94°)
MUESTRAS_NIVEL = 200  # ~0,2 s del acelerómetro al momento de la foto


class SinCalibracion(Exception):
    pass


def leer_calibracion(datos):
    m = PATRON.search(datos)
    if not m:
        raise SinCalibracion("El archivo no trae la calibración de los lentes.")
    v = [float(x) for x in m.group().decode().split("_")[1:]]
    if len(v) < 38:
        raise SinCalibracion("Calibración incompleta.")
    lentes = []
    for i in range(2):
        p = v[i * 19:(i + 1) * 19]
        lentes.append({
            "xi": p[0], "fx": p[1], "fy": p[2], "cx": p[3], "cy": p[4],
            "ypr": np.radians(p[5:8]), "k": p[11:14], "p": p[14:16], "w": p[16],
        })
    return lentes


def _registros(datos):
    """Registros del trailer Insta360: {id: bytes}."""
    if datos[-32:] != MAGIA:
        return {}
    total = struct.unpack("<I", datos[-40:-36])[0]
    fin, off, regs = len(datos), 72, {}
    while off < total:
        _, rid, tam = struct.unpack("<BBI", datos[fin - off - 6:fin - off])
        if tam <= 0 or tam > fin - off - 6:
            break
        regs[rid] = datos[fin - off - 6 - tam:fin - off - 6]
        off += tam + 6
    return regs


def leer_gravedad(datos):
    """Dirección "abajo" en el sistema del lente frontal (x der, y abajo, z adelante), o None."""
    imu = _registros(datos).get(0x03)
    if not imu or len(imu) % 20:
        return None
    muestras = np.frombuffer(imu, dtype=np.dtype([("t", "<u8"), ("v", "<u2", 6)]))
    acc = muestras["v"][:MUESTRAS_NIVEL, :3].astype(float) - 32768
    acc = acc[np.linalg.norm(acc, axis=1) > 1]
    if not len(acc):
        return None
    acc = (acc / np.linalg.norm(acc, axis=1)[:, None]).mean(0)
    g = np.array([-acc[2], -acc[0], acc[1]])
    return g / np.linalg.norm(g)


def _rot(yaw, pitch, roll):
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    cr, sr = np.cos(roll), np.sin(roll)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return rz @ rx @ ry


def _alinear(a, b):
    """Rotación mínima que lleva el vector unitario a hacia b."""
    v, c = np.cross(a, b), float(np.dot(a, b))
    if c < -0.9999:
        return np.diag([1.0, -1.0, -1.0])
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)


def _proyectar(d, lente, escala):
    """Direcciones (N,3) en el sistema del lente -> píxeles (u, v) y ángulo al eje."""
    x, y, z = d[:, 0], d[:, 1], d[:, 2]
    den = z + lente["xi"]
    mx, my = x / den, y / den
    r2 = mx * mx + my * my
    k1, k2, k3 = lente["k"]
    p1, p2 = lente["p"]
    rad = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
    dx = mx * rad + 2 * p1 * mx * my + p2 * (r2 + 2 * mx * mx)
    dy = my * rad + p1 * (r2 + 2 * my * my) + 2 * p2 * mx * my
    u = (lente["fx"] * dx + lente["cx"]) * escala
    v = (lente["fy"] * dy + lente["cy"]) * escala
    theta = np.arccos(np.clip(z, -1, 1))
    return u.astype(np.float32), v.astype(np.float32), theta


def _traslaciones(datos):
    """Posición de cada lente (m) respecto al punto medio entre ambos, en el sistema del lente frontal."""
    v = [float(x) for x in PATRON.search(datos).group().decode().split("_")[1:]]
    t1, t2 = np.array(v[8:11]), np.array(v[19 + 8:19 + 11])
    medio = (t1 + t2) / 2
    return [t1 - medio, t2 - medio]


def _rotaciones(lentes):
    rots = []
    for i, l in enumerate(lentes):
        yaw, pitch, roll = l["ypr"]
        r = _rot(yaw, -pitch, roll - np.pi / 2)
        if i == 1:  # el lente trasero mira hacia atrás
            r = r @ np.diag([-1.0, 1.0, -1.0])
        rots.append(r)
    return rots


def _hacia_lente(d, inv_d, t):
    """Dirección con que el lente ubicado en `t` ve el punto a distancia 1/inv_d en la dirección d."""
    p = d - inv_d[:, None] * t
    return p / np.linalg.norm(p, axis=1)[:, None]


def _banda(img, lentes, rots, trasl, escala, inv_d):
    """Muestras de cada lente sobre la franja de la costura (θ 84°–96°), para una distancia fija."""
    phi = (np.arange(N_PHI) + 0.5) / N_PHI * 2 * np.pi - np.pi
    th = np.radians(np.linspace(84, 96, N_TH))
    PH, TH = np.meshgrid(phi, th)
    d = np.stack([np.sin(TH) * np.cos(PH), np.sin(TH) * np.sin(PH), np.cos(TH)], -1).reshape(-1, 3)
    iv = np.full(len(d), inv_d)
    salida = []
    for l, r, t in zip(lentes, rots, trasl):
        u, v, _ = _proyectar(_hacia_lente(d, iv, t) @ r.T, l, escala)
        salida.append(cv2.remap(img, u.reshape(N_TH, N_PHI), v.reshape(N_TH, N_PHI), cv2.INTER_LINEAR).astype(np.float32))
    return salida


def _camino(costos, lam_rel):
    """costos (K, N_PHI) -> índice por ángulo, suave: programación dinámica sobre el círculo de la costura."""
    k, n = costos.shape
    lam = lam_rel * float(np.median(costos)) + 1e-6
    salto = lam * np.abs(np.arange(k)[:, None] - np.arange(k)[None, :])
    c3 = np.concatenate([costos, costos, costos], 1)  # 3 vueltas, se usa la del medio
    acum = c3[:, 0].copy()
    desde = np.zeros((3 * n, k), int)
    for j in range(1, 3 * n):
        total = acum[None, :] + salto
        desde[j] = total.argmin(1)
        acum = total.min(1) + c3[:, j]
    idx = np.empty(3 * n, int)
    idx[-1] = acum.argmin()
    for j in range(3 * n - 1, 0, -1):
        idx[j - 1] = desde[j, idx[j]]
    return idx[n:2 * n]


def _suavizar_circular(x, ancho):
    return np.convolve(np.r_[x[-ancho:], x, x[:ancho]], np.ones(2 * ancho + 1) / (2 * ancho + 1), "valid")


def _gauss_circular(x, sigma):
    r = int(3 * sigma)
    g = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    return np.convolve(np.r_[x[-r:], x, x[:r]], g / g.sum(), "valid")


def costura(img, lentes, rots, trasl):
    """Por cada ángulo de la costura: 1/distancia que mejor calza ambos lentes y ángulo (θ) de la línea de corte."""
    gris = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) if img.ndim == 3 else img
    if gris.shape[1] > 3000:
        gris = cv2.resize(gris, (2976, 1488), interpolation=cv2.INTER_AREA)
    escala = gris.shape[1] / lentes[0]["w"]
    difs = []
    for inv in INV_D:
        a, b = _banda(gris, lentes, rots, trasl, escala, inv)
        difs.append(np.abs((a - a.mean()) - (b - b.mean())))
    difs = np.array(difs)  # (K, N_TH, N_PHI)

    # 1) Distancia: error promedio en toda la franja, por ángulo.
    costo_d = np.stack([_suavizar_circular(f, 4) for f in difs.mean(1)])
    k = _camino(costo_d, 0.15)
    inv_d = _gauss_circular(INV_D[k], 3)

    # 2) Línea de corte: dentro del solape, por donde ambos lentes más coinciden a esa distancia.
    d = difs[k, :, np.arange(N_PHI)].T  # (N_TH, N_PHI)
    d = cv2.blur(d.astype(np.float32), (9, 7), borderType=cv2.BORDER_REPLICATE)
    filas = np.array(list(FILAS_CORTE))
    fila = _camino(d[filas], 0.3)
    th_corte = _gauss_circular(TH_BANDA[filas[fila]], 2)
    return inv_d, np.radians(th_corte)


def _ganancias(img, lentes, rots, trasl, inv_d):
    """Iguala el color de los dos lentes en la costura (mitad de la corrección a cada uno)."""
    chica = cv2.resize(img, (2976, 1488), interpolation=cv2.INTER_AREA) if img.shape[1] > 3000 else img
    escala = chica.shape[1] / lentes[0]["w"]
    a, b = _banda(chica, lentes, rots, trasl, escala, float(np.median(inv_d)))
    m1 = a.reshape(-1, 3).mean(0) + 1
    m2 = b.reshape(-1, 3).mean(0) + 1
    g = np.clip(np.sqrt(m2 / m1), 0.8, 1.25)
    return [g, 1 / g]


def unir(datos, img, ancho_salida=None, nivelar=True, paralaje=True):
    """`datos`: bytes del .insp; `img`: array RGB (H, W, 3) del mismo archivo. Devuelve RGB 2:1."""
    lentes = leer_calibracion(datos)
    escala = img.shape[1] / lentes[0]["w"]
    W = ancho_salida or img.shape[1]
    H = W // 2

    nivel = np.eye(3)
    g = leer_gravedad(datos) if nivelar else None
    if g is not None:
        nivel = _alinear(np.array([0.0, 1.0, 0.0]), g)

    rots = _rotaciones(lentes)
    trasl = _traslaciones(datos)
    if paralaje:
        inv_d, th_corte = costura(img, lentes, rots, trasl)
    else:
        inv_d, th_corte = np.zeros(N_PHI), np.full(N_PHI, np.pi / 2)
    ganancias = _ganancias(img, lentes, rots, trasl, inv_d)

    salida = np.empty((H, W, 3), np.uint8)
    lon = (np.arange(W) + 0.5) / W * 2 * np.pi - np.pi
    paso = 256  # filas por bloque, para no pasar de ~300 MB de RAM
    for f0 in range(0, H, paso):
        f1 = min(H, f0 + paso)
        filas = f1 - f0
        lat = np.pi / 2 - (np.arange(f0, f1) + 0.5) / H * np.pi
        LON, LAT = np.meshgrid(lon, lat)
        d = np.stack([np.cos(LAT) * np.sin(LON), -np.sin(LAT), np.cos(LAT) * np.cos(LON)], -1).reshape(-1, 3)
        d = d @ nivel.T  # al sistema de la cámara
        # Distancia de la costura según el ángulo; se desvanece hacia el centro de cada lente.
        phi = np.arctan2(d[:, 1], d[:, 0])
        pos = ((phi + np.pi) / (2 * np.pi) * N_PHI - 0.5) % N_PHI
        i0 = np.floor(pos).astype(int)
        fr = pos - i0
        i1 = (i0 + 1) % N_PHI
        iv = (inv_d[i0] * (1 - fr) + inv_d[i1] * fr) * (1 - d[:, 2] ** 2)
        corte = th_corte[i0] * (1 - fr) + th_corte[i1] * fr
        # Peso del lente frontal: 1 antes de la línea de corte, 0 después, con mezcla corta.
        w1 = np.clip((corte + FEATHER - np.arccos(np.clip(d[:, 2], -1, 1))) / (2 * FEATHER), 0, 1).astype(np.float32)

        acum = np.zeros((d.shape[0], 3), np.float32)
        pesos = np.zeros(d.shape[0], np.float32)
        for l, r, t, gan, w in zip(lentes, rots, trasl, ganancias, (w1, 1 - w1)):
            u, v, _ = _proyectar(_hacia_lente(d, iv, t) @ r.T, l, escala)
            muestra = cv2.remap(img, u.reshape(filas, W), v.reshape(filas, W), cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_CONSTANT).reshape(-1, 3)
            acum += muestra * (w[:, None] * gan.astype(np.float32))
            pesos += w
        bloque = acum / np.maximum(pesos, 1e-6)[:, None]
        salida[f0:f1] = np.clip(bloque, 0, 255).astype(np.uint8).reshape(filas, W, 3)
    return salida
