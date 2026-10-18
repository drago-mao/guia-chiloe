# Chiloé a tu Manera – V 1.15

Guía de Chiloé con mapa, lugares, horarios, teléfonos, valoraciones y mareas de Castro siempre al día.
Se publica sola en Netlify cada vez que se sube un cambio a la rama `main` de este repositorio.

## Perfiles
| Perfil | Cómo entra | Qué puede hacer |
|---|---|---|
| **Administrador** | Con su correo y contraseña | Editar todo desde la web: agregar, cambiar o quitar lugares (con foto y ubicación en el mapa), crear, renombrar, ordenar o eliminar secciones (Comer, Visitar…), aprobar o rechazar sugerencias, editar las mareas, ver usuarios, cambiar su perfil, darles una contraseña nueva o borrarlos |
| **Usuario registrado** | Crea su cuenta en la app | Ver todo, guardar favoritos (se sincronizan entre sus aparatos), sugerir lugares y cambiar su contraseña |
| **Visualizador** | Botón "Solo mirar, sin cuenta" | Solo mirar. Sus favoritos quedan en su teléfono |

## Recorridos con camino (V 1.14)
Botón del mapa (o menú ⋯ > "Recorridos con el camino"). Son 12 salidas de un día desde Castro: eliges una y el mapa muestra el camino real, las paradas numeradas, los cruces en barco o lancha (línea punteada) y los lugares de la guía que quedan cerca del camino. Desde ahí se abre la ruta en Google Maps.
- Los datos están en `public/rutas.json` (caminos calculados con OSRM sobre OpenStreetMap, el 18-10-2026). Para cambiar textos o paradas se edita ese archivo y se corre `npm test`, que revisa que los tramos estén pegados y las paradas dentro de Chiloé.
- Tiempos y distancias son aproximados en auto, sin paradas ni esperas. El tramo de lancha a Isla Mechuque es una línea recta de referencia.

## Primera vez: crear al administrador
1. Abre la guía en internet.
2. Toca **"Primera vez: configurar al administrador"** (aparece solo mientras no exista administrador).
3. Escribe el código de instalación (te lo entrega quien armó la guía), tu nombre, correo y contraseña.

El código solo sirve una vez. Después, el botón desaparece.

## Cómo está hecha
- `public/index.html`: la app (mapa Leaflet + OpenStreetMap).
- `netlify/functions/api.mjs`: servidor (cuentas, lugares, fotos, sugerencias, mareas). Guarda los datos en Netlify Blobs.
- `netlify/functions/seed.mjs`: los 65 lugares y las mareas iniciales (se cargan solo la primera vez).
- `netlify/functions/mareas-calc.mjs`: calcula las mareas de Castro para cualquier fecha (ver "Mareas siempre al día").
- `tools/calibrar-mareas.mjs`: repite la calibración de las mareas si algún día hay una tabla de Castro más larga o más confiable.
- `public/rutas.json`: los recorridos (caminos y paradas).
- `tests/`: pruebas automáticas (`npm test`).

## Mareas siempre al día
Las mareas de Castro **no hay que cargarlas**: el servidor las calcula cada vez que alguien abre la pantalla, desde ayer hasta 30 días después de hoy (hora de Chile, con cambio de horario incluido). No dependen de ningún sitio externo ni de claves.

- **Cómo se calculan:** constantes armónicas de la estación Puerto Montt (la más cercana con datos abiertos; TICON-4, licencia CC BY 4.0, vía la base abierta `@neaps/tide-database`), corregidas para Castro con 5 números calibrados con 10 días de mareas de Castro del modelo FES2022 (tidesatlas.com, 18-10-2026).
- **Qué tan exactas son:** contra esos 10 días el error típico es de ~7 minutos y ~6 cm (máximo 19 min y 14 cm); calibrando con una parte de los días y probando con la otra, 5–9 min y 5–7 cm. La app avisa que pueden diferir hasta unos 30 minutos y 20 cm de la tabla oficial del SHOA. Solo son predicciones astronómicas: no incluyen viento ni lluvia, y no sirven para navegar.
- **Corrección a mano:** el administrador puede cambiar cualquier día desde Panel > Mareas. Lo que escriba reemplaza el cálculo de esos días y el resto sigue calculándose solo.
- **Mejorarlas:** con una tabla de Castro más larga (idealmente de un año, por ejemplo la oficial del SHOA) se corre `node tools/calibrar-mareas.mjs tabla.json` y se pegan los 5 números nuevos en `CALIB`.

## Secciones editables
El administrador maneja las secciones desde **Menú > Panel de administración > Secciones**: agregar (nombre, ícono y color), editar, subir o bajar para cambiar el orden y eliminar. Puede haber hasta 12. Al eliminar una sección con lugares (o con sugerencias pendientes) hay que elegir a qué sección pasan, así nunca se pierde nada. "Guardados" es especial: siempre va al final y no se edita. Se guardan en Netlify Blobs; mientras no se cambie nada, quedan las 4 de partida.

## Cosas a saber
- No hay correo de "olvidé mi contraseña": el administrador crea una contraseña temporal desde Panel > Usuarios.
- Los enlaces cortos de Google Maps (maps.app.goo.gl) no traen la ubicación; usa "Elegir en el mapa".
- Las cuentas antiguas que estaban guardadas en cada teléfono (V 1.6) ya no sirven: hay que crear la cuenta de nuevo.
