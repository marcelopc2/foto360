import shutil
import tempfile
from io import BytesIO

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from PIL import Image, ImageDraw

from .models import Album, Foto

MEDIA = tempfile.mkdtemp()
CALIBRACION_X5 = (
    b"2_2.000000_4279.470_4279.370_2681.330_2704.090_0.340_-0.357_90.923_0.000000_0.000000_0.000000"
    b"_0.18140894_2.08603954_-3.23688340_-0.00171763_-0.00305695_10752_5376_113_2.000000_4280.550_4280.830"
    b"_8064.580_2698.350_0.143_-0.286_88.934_-0.001142_0.000130_-0.032163_0.17894790_2.11023021_-3.33960962"
    b"_-0.00270933_0.00107453_10752_5376_113_197632"
)


def jpg(ancho, alto, nombre="IMG_20260101_120000_00_001.jpg"):
    buf = BytesIO()
    Image.new("RGB", (ancho, alto), (90, 140, 200)).save(buf, "JPEG")
    return SimpleUploadedFile(nombre, buf.getvalue(), content_type="image/jpeg")


@override_settings(MEDIA_ROOT=__import__("pathlib").Path(MEDIA))
class GaleriaTests(TestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        User.objects.create_user("marcelo", password="clave-larga-123")
        self.album = Album.objects.create(titulo="Prueba")

    def test_admin_requiere_login(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 302)
        r = self.client.post(f"/album/{self.album.pk}/subir/", {"foto": jpg(1000, 500)})
        self.assertEqual(r.status_code, 302)
        self.assertEqual(Foto.objects.count(), 0)

    def test_subir_y_ver_publico(self):
        self.client.login(username="marcelo", password="clave-larga-123")
        r = self.client.post(f"/album/{self.album.pk}/subir/", {"foto": jpg(9000, 4500)})
        self.assertEqual(r.status_code, 200, r.content)
        foto = Foto.objects.get()
        self.assertEqual(Image.open(foto.vista.path).size, (8192, 4096))
        self.assertEqual(Image.open(foto.vista_chica.path).size, (4096, 2048))
        self.assertEqual(Image.open(foto.miniatura.path).size, (640, 320))

        self.client.logout()
        t = self.album.token
        self.assertContains(self.client.get(f"/a/{t}/"), foto.miniatura.url)
        self.assertContains(self.client.get(f"/a/{t}/{foto.uid.hex}/"), foto.vista_chica.url)
        r = self.client.get(f"/a/{t}/{foto.uid}/descargar/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("attachment", r["Content-Disposition"])
        self.assertEqual(self.client.get("/a/token-falso/").status_code, 404)

    def test_rechaza_no_360_y_otros_formatos(self):
        self.client.login(username="marcelo", password="clave-larga-123")
        r = self.client.post(f"/album/{self.album.pk}/subir/", {"foto": jpg(1200, 900)})
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"/album/{self.album.pk}/subir/", {"foto": jpg(1000, 500, "x.png")})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Foto.objects.count(), 0)

    def test_nuevo_enlace_y_borrar(self):
        self.client.login(username="marcelo", password="clave-larga-123")
        self.client.post(f"/album/{self.album.pk}/subir/", {"foto": jpg(2000, 1000)})
        viejo = self.album.token
        self.client.post(f"/album/{self.album.pk}/nuevo-enlace/")
        self.album.refresh_from_db()
        self.assertNotEqual(viejo, self.album.token)
        self.assertEqual(self.client.get(f"/a/{viejo}/").status_code, 404)
        foto = Foto.objects.get()
        self.assertIn(self.album.token, foto.vista.name)
        self.assertTrue(foto.vista.storage.exists(foto.vista.name))

        self.client.post(f"/album/{self.album.pk}/borrar/")
        self.assertFalse(Album.objects.exists())
        self.assertFalse(foto.vista.storage.exists(foto.vista.name))

    def test_insp_se_une(self):
        # Dos ojos de pez sobre negro + la calibración real de una X5 al final del archivo.
        img = Image.new("RGB", (1488, 744))
        d = ImageDraw.Draw(img)
        d.ellipse((5, 5, 739, 739), fill=(200, 60, 60))
        d.ellipse((749, 5, 1483, 739), fill=(60, 60, 200))
        buf = BytesIO()
        img.save(buf, "JPEG")
        buf.write(CALIBRACION_X5)
        archivo = SimpleUploadedFile("IMG_20250904_172646_00_021.insp", buf.getvalue(), content_type="application/octet-stream")

        self.client.login(username="marcelo", password="clave-larga-123")
        r = self.client.post(f"/album/{self.album.pk}/subir/", {"foto": archivo})
        self.assertEqual(r.status_code, 200, r.content)
        foto = Foto.objects.get()
        unida = Image.open(foto.original.path)
        self.assertEqual(unida.size, (1488, 744))
        # Adelante (centro) se ve el lente 1 (rojo); atrás (bordes) el lente 2 (azul).
        self.assertGreater(unida.getpixel((744, 372))[0], 150)
        self.assertGreater(unida.getpixel((10, 372))[2], 150)
        r = self.client.get(f"/a/{self.album.token}/{foto.uid}/descargar/")
        self.assertIn('IMG_20250904_172646_00_021.jpg', r["Content-Disposition"])
        self.assertEqual(timezone.localtime(foto.tomada).strftime("%Y-%m-%d %H:%M"), "2025-09-04 17:26")

    def test_insp_sin_calibracion(self):
        img = Image.new("RGB", (1488, 744))
        d = ImageDraw.Draw(img)
        d.ellipse((5, 5, 739, 739), fill=(200, 60, 60))
        d.ellipse((749, 5, 1483, 739), fill=(60, 60, 200))
        buf = BytesIO()
        img.save(buf, "JPEG")
        self.client.login(username="marcelo", password="clave-larga-123")
        r = self.client.post(f"/album/{self.album.pk}/subir/", {"foto": SimpleUploadedFile("a.insp", buf.getvalue())})
        self.assertEqual(r.status_code, 400)
