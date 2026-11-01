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
FEATHER = np.radians(6)  # ancho de la mezcla en la costura
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


def unir(datos, img, ancho_salida=None, nivelar=True):
    """`datos`: bytes del .insp; `img`: array RGB (H, W, 3) del mismo archivo. Devuelve RGB 2:1."""
    lentes = leer_calibracion(datos)
    escala = img.shape[1] / lentes[0]["w"]
    W = ancho_salida or img.shape[1]
    H = W // 2

    nivel = np.eye(3)
    g = leer_gravedad(datos) if nivelar else None
    if g is not None:
        nivel = _alinear(np.array([0.0, 1.0, 0.0]), g)

    rots = []
    for i, l in enumerate(lentes):
        yaw, pitch, roll = l["ypr"]
        r = _rot(yaw, -pitch, roll - np.pi / 2)
        if i == 1:  # el lente trasero mira hacia atrás
            r = r @ np.diag([-1.0, 1.0, -1.0])
        rots.append(r @ nivel)

    salida = np.empty((H, W, 3), np.uint8)
    lon = (np.arange(W) + 0.5) / W * 2 * np.pi - np.pi
    paso = 256  # filas por bloque, para no pasar de ~300 MB de RAM
    for f0 in range(0, H, paso):
        f1 = min(H, f0 + paso)
        filas = f1 - f0
        lat = np.pi / 2 - (np.arange(f0, f1) + 0.5) / H * np.pi
        LON, LAT = np.meshgrid(lon, lat)
        d = np.stack([np.cos(LAT) * np.sin(LON), -np.sin(LAT), np.cos(LAT) * np.cos(LON)], -1).reshape(-1, 3)

        acum = np.zeros((d.shape[0], 3), np.float32)
        pesos = np.zeros(d.shape[0], np.float32)
        for l, r in zip(lentes, rots):
            u, v, theta = _proyectar(d @ r.T, l, escala)
            # Peso 1 dentro del lente; baja suave en la costura (90° ± FEATHER).
            w = np.clip((np.pi / 2 + FEATHER - theta) / (2 * FEATHER), 0, 1).astype(np.float32)
            muestra = cv2.remap(img, u.reshape(filas, W), v.reshape(filas, W), cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_CONSTANT).reshape(-1, 3)
            acum += muestra * w[:, None]
            pesos += w
        bloque = acum / np.maximum(pesos, 1e-6)[:, None]
        salida[f0:f1] = np.clip(bloque, 0, 255).astype(np.uint8).reshape(filas, W, 3)
    return salida
