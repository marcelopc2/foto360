import shutil
import tempfile
from io import BytesIO

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from PIL import Image

from .models import Album, Foto

MEDIA = tempfile.mkdtemp()


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

    def test_rechaza_no_360_y_no_jpg(self):
        self.client.login(username="marcelo", password="clave-larga-123")
        r = self.client.post(f"/album/{self.album.pk}/subir/", {"foto": jpg(1200, 900)})
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"/album/{self.album.pk}/subir/", {"foto": jpg(1000, 500, "x.insp")})
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
