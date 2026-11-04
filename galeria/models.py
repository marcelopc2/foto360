import secrets
import uuid

from django.db import models


def nuevo_token():
    return secrets.token_urlsafe(16)


def ruta_foto(instance, filename, sufijo):
    # Nombres aleatorios: las URLs de media no se pueden adivinar. La parte final cambia en cada
    # versión, así una foto re-procesada no se confunde con la que el navegador ya tiene en caché.
    return f"albums/{instance.album.token}/{instance.uid.hex}{sufijo}_{secrets.token_hex(3)}.jpg"


def ruta_original(instance, filename):
    return ruta_foto(instance, filename, "")


def ruta_vista(instance, filename):
    return ruta_foto(instance, filename, "_8k")


def ruta_vista_chica(instance, filename):
    return ruta_foto(instance, filename, "_4k")


def ruta_portada(instance, filename):
    return f"albums/{instance.token}/portada_{uuid.uuid4().hex[:12]}.jpg"


def ruta_miniatura(instance, filename):
    return ruta_foto(instance, filename, "_thumb")


class Album(models.Model):
    titulo = models.CharField(max_length=120)
    descripcion = models.TextField(blank=True)
    token = models.CharField(max_length=40, unique=True, default=nuevo_token, editable=False)
    creado = models.DateTimeField(auto_now_add=True)
    # Encuadre elegido desde el visor; si no hay, se usa la primera foto.
    imagen_portada = models.ImageField(upload_to=ruta_portada, blank=True)

    class Meta:
        ordering = ["-creado"]

    def __str__(self):
        return self.titulo

    @property
    def portada(self):
        return self.fotos.first()

    @property
    def portada_url(self):
        """Imagen grande para la cabecera del álbum."""
        if self.imagen_portada:
            return self.imagen_portada.url
        p = self.portada
        return p.vista_chica.url if p else ""

    @property
    def portada_miniatura_url(self):
        """Imagen chica para tarjetas y vista previa de WhatsApp."""
        if self.imagen_portada:
            return self.imagen_portada.url
        p = self.portada
        return p.miniatura.url if p else ""


class Foto(models.Model):
    album = models.ForeignKey(Album, related_name="fotos", on_delete=models.CASCADE)
    uid = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    titulo = models.CharField(max_length=120, blank=True)
    nombre_original = models.CharField(max_length=255, blank=True)
    original = models.ImageField(upload_to=ruta_original)
    vista = models.ImageField(upload_to=ruta_vista)
    vista_chica = models.ImageField(upload_to=ruta_vista_chica)
    miniatura = models.ImageField(upload_to=ruta_miniatura)
    ancho = models.PositiveIntegerField(default=0)
    alto = models.PositiveIntegerField(default=0)
    tomada = models.DateTimeField(null=True, blank=True)
    subida = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["tomada", "subida"]

    def __str__(self):
        return self.titulo or self.nombre_original

    def delete(self, *args, **kwargs):
        archivos = [self.original, self.vista, self.vista_chica, self.miniatura]
        super().delete(*args, **kwargs)
        for f in archivos:
            if f:
                f.storage.delete(f.name)
