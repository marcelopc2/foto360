from django.urls import path

from . import views

urlpatterns = [
    path("", views.inicio, name="inicio"),
    path("album/<int:pk>/", views.album_admin, name="album_admin"),
    path("album/<int:pk>/subir/", views.subir, name="subir"),
    path("album/<int:pk>/borrar/", views.borrar_album, name="borrar_album"),
    path("album/<int:pk>/nuevo-enlace/", views.nuevo_enlace, name="nuevo_enlace"),
    path("foto/<int:pk>/borrar/", views.borrar_foto, name="borrar_foto"),
    path("a/<str:token>/", views.album_publico, name="album_publico"),
    path("a/<str:token>/<str:uid>/", views.visor, name="visor"),
    path("a/<str:token>/<uuid:uid>/descargar/", views.descargar, name="descargar"),
]
