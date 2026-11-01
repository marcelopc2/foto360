import shutil

from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import FileResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_POST

from .imagenes import FotoInvalida, procesar
from .models import Album, Foto, nuevo_token

EXTENSIONES = (".jpg", ".jpeg", ".insp")


# ---------- Administración (solo tú) ----------

@login_required
def inicio(request):
    if request.method == "POST":
        titulo = request.POST.get("titulo", "").strip()
        if titulo:
            album = Album.objects.create(titulo=titulo[:120])
            return redirect("album_admin", pk=album.pk)
    albums = Album.objects.prefetch_related("fotos")
    return render(request, "galeria/inicio.html", {"albums": albums})


@login_required
def album_admin(request, pk):
    album = get_object_or_404(Album, pk=pk)
    if request.method == "POST":
        album.titulo = request.POST.get("titulo", album.titulo).strip()[:120] or album.titulo
        album.descripcion = request.POST.get("descripcion", "").strip()
        album.save()
        messages.success(request, "Álbum guardado.")
        return redirect("album_admin", pk=album.pk)
    enlace = request.build_absolute_uri(f"/a/{album.token}/")
    return render(request, "galeria/album_admin.html", {"album": album, "enlace": enlace})


@login_required
@require_POST
def subir(request, pk):
    album = get_object_or_404(Album, pk=pk)
    archivo = request.FILES.get("foto")
    if not archivo:
        return JsonResponse({"ok": False, "error": "No llegó ningún archivo."}, status=400)
    if not archivo.name.lower().endswith(EXTENSIONES):
        return JsonResponse(
            {"ok": False, "error": "Solo fotos .insp (directo de la cámara) o .jpg 360."},
            status=400,
        )
    foto = Foto(album=album, nombre_original=archivo.name[:255])
    try:
        procesar(foto, archivo)
    except FotoInvalida as e:
        return JsonResponse({"ok": False, "error": str(e)}, status=400)
    foto.save()
    return JsonResponse({"ok": True, "id": foto.pk, "miniatura": foto.miniatura.url})


@login_required
@require_POST
def borrar_foto(request, pk):
    foto = get_object_or_404(Foto, pk=pk)
    album_pk = foto.album_id
    foto.delete()
    return redirect("album_admin", pk=album_pk)


@login_required
@require_POST
def borrar_album(request, pk):
    album = get_object_or_404(Album, pk=pk)
    for foto in album.fotos.all():
        foto.delete()
    shutil.rmtree(settings.MEDIA_ROOT / "albums" / album.token, ignore_errors=True)
    album.delete()
    messages.success(request, f"Álbum «{album.titulo}» eliminado.")
    return redirect("inicio")


@login_required
@require_POST
def nuevo_enlace(request, pk):
    """Invalida el link anterior (por si se compartió donde no debía)."""
    album = get_object_or_404(Album, pk=pk)
    viejo = settings.MEDIA_ROOT / "albums" / album.token

    album.token = nuevo_token()
    album.save()
    nuevo = settings.MEDIA_ROOT / "albums" / album.token
    if viejo.exists():
        viejo.rename(nuevo)
    for foto in album.fotos.all():
        for campo in ("original", "vista", "vista_chica", "miniatura"):
            f = getattr(foto, campo)
            f.name = f.name.replace(viejo.name, album.token, 1)
        foto.save()
    messages.success(request, "Link nuevo generado. El anterior ya no funciona.")
    return redirect("album_admin", pk=album.pk)


# ---------- Público (con el link secreto) ----------

def album_publico(request, token):
    album = get_object_or_404(Album, token=token)
    return render(request, "galeria/album_publico.html", {"album": album, "fotos": album.fotos.all()})


def visor(request, token, uid):
    album = get_object_or_404(Album, token=token)
    fotos = list(album.fotos.all())
    actual = next((f for f in fotos if f.uid.hex == uid), None)
    if actual is None:
        return redirect("album_publico", token=token)
    i = fotos.index(actual)
    return render(request, "galeria/visor.html", {
        "album": album,
        "foto": actual,
        "fotos": fotos,
        "anterior": fotos[i - 1] if i > 0 else None,
        "siguiente": fotos[i + 1] if i < len(fotos) - 1 else None,
        "posicion": i + 1,
    })


def descargar(request, token, uid):
    album = get_object_or_404(Album, token=token)
    foto = get_object_or_404(Foto, album=album, uid=uid)
    base = (foto.nombre_original or foto.uid.hex).rsplit(".", 1)[0]
    nombre = f"{base}.jpg"
    return FileResponse(foto.original.open("rb"), as_attachment=True, filename=nombre)
