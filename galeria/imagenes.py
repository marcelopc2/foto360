"""Genera las versiones livianas de una foto 360 (equirectangular 2:1)."""
from datetime import datetime
from io import BytesIO

from django.core.files.base import ContentFile
from django.utils import timezone
from PIL import Image, ImageOps

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

    # Los .insp sin exportar son dos ojos de pez lado a lado: esquinas negras.
    chica = img.resize((64, 32))
    esquinas = [chica.getpixel(p) for p in ((0, 0), (63, 0), (0, 31), (63, 31), (31, 0), (31, 31))]
    if all(sum(px) < 15 for px in esquinas):
        raise FotoInvalida(
            "Parece una foto sin unir (dos círculos). Expórtala primero como foto 360 desde Insta360 Studio o la app."
        )

    foto.ancho, foto.alto = img.size
    foto.tomada = fecha
    archivo.seek(0)
    foto.original.save("o.jpg", archivo, save=False)
    foto.vista.save("v.jpg", _jpeg(img, TAMANOS["vista"], 85), save=False)
    foto.vista_chica.save("c.jpg", _jpeg(img, TAMANOS["vista_chica"], 82), save=False)
    foto.miniatura.save("t.jpg", _jpeg(img, TAMANOS["miniatura"], 78), save=False)
