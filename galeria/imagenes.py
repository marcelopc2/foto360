"""Genera las versiones livianas de una foto 360 (equirectangular 2:1); une los .insp."""
from datetime import datetime
from io import BytesIO

from django.core.files.base import ContentFile
from django.utils import timezone
import numpy as np
from PIL import Image, ImageOps

from . import unir

# La X5 exporta 11904x5952 (72 MP); el límite por defecto de Pillow es ~89 MP.
Image.MAX_IMAGE_PIXELS = 200_000_000

TAMANOS = {"vista": 8192, "vista_chica": 4096, "miniatura": 640}


class FotoInvalida(Exception):
    pass


def _jpeg(img, ancho, calidad):
    if img.width > ancho:
        img = img.resize((ancho, ancho // 2), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, "JPEG", quality=calidad, optimize=True, progressive=True)
    return ContentFile(buf.getvalue())


def _fecha_exif(img):
    try:
        exif = img.getexif()
        valor = exif.get_ifd(0x8769).get(36867) or exif.get(306)  # DateTimeOriginal / DateTime
        if valor:
            return timezone.make_aware(datetime.strptime(valor.strip("\x00 "), "%Y:%m:%d %H:%M:%S"))
    except Exception:
        pass
    return None


def _sin_unir(img):
    """Los .insp son dos ojos de pez lado a lado: esquinas y centro-arriba/abajo negros."""
    chica = img.resize((64, 32))
    puntos = ((0, 0), (63, 0), (0, 31), (63, 31), (31, 0), (31, 31))
    return all(sum(chica.getpixel(p)) < 15 for p in puntos)


def procesar(foto, archivo):
    """Llena los campos de imagen de `foto` (sin guardarla) a partir del archivo subido."""
    try:
        img = Image.open(archivo)
        img.verify()
        archivo.seek(0)
        img = Image.open(archivo)
        fecha = _fecha_exif(img)
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception as e:
        raise FotoInvalida("El archivo no es una imagen válida.") from e

    if abs(img.width / img.height - 2) > 0.05:
        raise FotoInvalida(
            f"No parece una foto 360 ({img.width}x{img.height}). "
            "Expórtala desde Insta360 Studio o la app como JPG 360 (proporción 2:1)."
        )

    foto.tomada = fecha
    archivo.seek(0)
    if _sin_unir(img):
        # .insp tal como sale de la cámara: dos ojos de pez. Lo unimos aquí.
        datos = archivo.read()
        try:
            img = Image.fromarray(unir.unir(datos, np.asarray(img)))
        except unir.SinCalibracion as e:
            raise FotoInvalida(
                "La foto viene sin unir y no trae la calibración de la cámara. "
                "Expórtala como foto 360 desde Insta360 Studio o la app."
            ) from e
        foto.original.save("o.jpg", _jpeg(img, img.width, 92), save=False)
    else:
        foto.original.save("o.jpg", archivo, save=False)

    foto.ancho, foto.alto = img.size
    foto.vista.save("v.jpg", _jpeg(img, TAMANOS["vista"], 85), save=False)
    foto.vista_chica.save("c.jpg", _jpeg(img, TAMANOS["vista_chica"], 82), save=False)
    foto.miniatura.save("t.jpg", _jpeg(img, TAMANOS["miniatura"], 78), save=False)
