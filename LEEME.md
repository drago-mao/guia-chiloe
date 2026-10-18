# Chiloé a tu Manera – V 1.10

Guía de Chiloé con mapa, lugares, horarios, teléfonos, valoraciones y mareas de Castro.
Se publica sola en Netlify cada vez que se sube un cambio a la rama `main` de este repositorio.

## Perfiles
| Perfil | Cómo entra | Qué puede hacer |
|---|---|---|
| **Administrador** | Con su correo y contraseña | Editar todo desde la web: agregar, cambiar o quitar lugares (con foto y ubicación en el mapa), aprobar o rechazar sugerencias, editar las mareas, ver usuarios, cambiar su perfil, darles una contraseña nueva o borrarlos |
| **Usuario registrado** | Crea su cuenta en la app | Ver todo, guardar favoritos (se sincronizan entre sus aparatos), sugerir lugares y cambiar su contraseña |
| **Visualizador** | Botón "Solo mirar, sin cuenta" | Solo mirar. Sus favoritos quedan en su teléfono |

## Primera vez: crear al administrador
1. Abre la guía en internet.
2. Toca **"Primera vez: configurar al administrador"** (aparece solo mientras no exista administrador).
3. Escribe el código de instalación (te lo entrega quien armó la guía), tu nombre, correo y contraseña.

El código solo sirve una vez. Después, el botón desaparece.

## Cómo está hecha
- `public/index.html`: la app (mapa Leaflet + OpenStreetMap).
- `netlify/functions/api.mjs`: servidor (cuentas, lugares, fotos, sugerencias, mareas). Guarda los datos en Netlify Blobs.
- `netlify/functions/seed.mjs`: los 65 lugares y las mareas iniciales (se cargan solo la primera vez).
- `tests/`: pruebas automáticas (`npm test`).

## Cosas a saber
- No hay correo de "olvidé mi contraseña": el administrador crea una contraseña temporal desde Panel > Usuarios.
- Los enlaces cortos de Google Maps (maps.app.goo.gl) no traen la ubicación; usa "Elegir en el mapa".
- Las cuentas antiguas que estaban guardadas en cada teléfono (V 1.6) ya no sirven: hay que crear la cuenta de nuevo.
