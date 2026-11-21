# radio_topic_skip · Plugin para Volumio 3.x y 4.x

Versión 0.1.6 · 20261121
Autor: Sergio Rodríguez Ballester, Ingeniero Técnico Topógrafo

Mientras suena una emisora de la lista, el plugin transcribe el audio sin conexión (con Vosk y un modelo pequeño en español) y busca palabras clave. Si durante el **tiempo de detección** el porcentaje de bloques de la temática supera el **umbral**, salta a la siguiente emisora. Al llegar a la última vuelve a la primera.

## Instalación (en la Raspberry, por SSH)

```bash
# 1) Activa SSH en http://volumio.local/dev y entra:  ssh volumio@volumio.local  (clave: volumio)
# 2) Copia la carpeta del plugin a la Pi (desde tu PC):
scp -r radio_topic_skip volumio@volumio.local:/home/volumio/
# 3) En la Pi:
cd /home/volumio/radio_topic_skip
npm install --production
volumio plugin install        # instala y ejecuta install.sh (descarga el modelo, unos 40 MB)
```

Después: **Plugins → Plugins instalados → Salto de emisora por temática** → actívalo y configúralo.

## Ajustes

| Ajuste | Por defecto | Qué hace |
| --- | --- | --- |
| Lista de emisoras | Mis radios web | «Mis radios web», una **playlist de Volumio** (p. ej. Radio1) o una lista `Nombre\|URL ; ...` |
| Sensibilidad | 2 · Media | Nivel predefinido (ver tabla de abajo) o **Personalizada** |
| Tiempo de detección · Umbral · Bloque · Puntuación | (según nivel) | Solo se muestran y se aplican con «Personalizada» |
| Pausa entre bloques | 0 s | Descanso tras cada bloque: menos CPU, detección más lenta |
| Fichero de palabras | (vacío) | Vacío = `worker/keywords_futbol.txt` |


### Niveles de sensibilidad

| Nivel | Bloque | Detección | Umbral | Puntuación |
| --- | --- | --- | --- | --- |
| 1 · Baja | 15 s | 180 s | 70 % | 3 |
| 2 · Media | 10 s | 90 s | 50 % | 2,5 |
| 3 · Alta | 10 s | 60 s | 40 % | 2 |
| 4 · Muy alta | 10 s | 30 s | 30 % | 1,5 |

## Ajustar las palabras clave

Edita `worker/keywords_futbol.txt` (una expresión por línea, con peso opcional `;peso`). Pruébalo sin la radio:

```bash
python3 worker/topic_worker.py --keywords worker/keywords_futbol.txt --min-hits 3 \
  --text "remate de cabeza, el portero despeja a córner"
```

Prueba con una emisora real y sin cambiar nada en Volumio:

```bash
python3 worker/topic_worker.py --url "URL_DEL_STREAM" --model model --keywords worker/keywords_futbol.txt
```

## Diagnóstico

```bash
journalctl -f | grep radio_topic_skip     # activa "Registro detallado" para ver cada bloque
```

## Limitaciones conocidas

- Al saltar, **avanza dentro de la cola** (p. ej. la playlist Radio1) sin borrarla. Si la emisora no está en la cola, carga en ella la lista completa.
- En una Pi 3, Vosk va más lento que el tiempo real: el worker analiza siempre el audio más reciente y descarta lo que no le da tiempo a procesar (no acumula retraso).
- El plugin abre una **segunda conexión** al stream para analizarlo, así que consume el doble de ancho de banda y el análisis va unos segundos por detrás de lo que oyes.
- CPU: en una Pi 3B (32 bits) Vosk ocupa un núcleo al ~95 % y procesa unas 2,3 veces más lento que el tiempo real. Usa la pausa si quieres liberar CPU.
- Solo detecta lo que se **dice**. Si un locutor habla de fútbol en un informativo durante 2 minutos, también salta. Para evitarlo, sube el tiempo de detección o el umbral.

## Probar una emisora a mano

`worker/probar_radio.sh` lista las emisoras numeradas (`./probar_radio.sh`) o analiza una (`./probar_radio.sh N`). Para usar una playlist: `RADIOS=/data/playlist/Radio1 ./probar_radio.sh`.
