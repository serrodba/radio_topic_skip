#!/bin/bash
# Instalacion de dependencias de radio_topic_skip
# Probado para Volumio 4.x (Debian Bookworm, Python 3.11, armhf). Compatible con 3.x.
PLUGIN_DIR="/data/plugins/system_controller/radio_topic_skip"
MODEL_NAME="vosk-model-small-es-0.42"
MODEL_URL="https://alphacephei.com/vosk/models/${MODEL_NAME}.zip"

# Ejecuta como usuario volumio (es quien lanza el worker)
as_volumio() {
  if [ "$(id -un)" = "volumio" ]; then bash -c "$1"; else sudo -u volumio -H bash -c "$1"; fi
}

echo "== radio_topic_skip: instalando dependencias =="

# 1) ffmpeg (Volumio ya lo trae; solo se intenta apt si falta)
if ! command -v ffmpeg >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends ffmpeg || echo "ERROR: no se pudo instalar ffmpeg"
fi

# 2) pip para el usuario volumio (sin apt: en Volumio 4 apt puede estar inconsistente)
if ! as_volumio "python3 -m pip --version" >/dev/null 2>&1; then
  echo "pip no disponible: instalando con get-pip.py (usuario volumio)"
  as_volumio "cd /tmp && wget -q -O get-pip.py https://bootstrap.pypa.io/get-pip.py && python3 get-pip.py --user --break-system-packages" \
    || echo "ERROR: no se pudo instalar pip"
fi

# 3) vosk en el usuario volumio (PEP 668 -> --break-system-packages, solo en ~/.local)
if ! as_volumio "python3 -c 'import vosk'" 2>/dev/null; then
  # piwheels: ruedas precompiladas armhf (cffi no tiene rueda armv7l en PyPI y Volumio no trae gcc)
  as_volumio "python3 -m pip install --user --break-system-packages --extra-index-url https://www.piwheels.org/simple --only-binary=cffi vosk" \
    || as_volumio "python3 -m pip install --user vosk" \
    || echo "ERROR: no se pudo instalar vosk"
fi

# 4) Modelo de espanol (~40 MB). Se descomprime con Python (no hace falta unzip)
if [ ! -d "${PLUGIN_DIR}/model" ]; then
  echo "Descargando modelo ${MODEL_NAME}..."
  cd /tmp && wget -q -O vosk_model.zip "$MODEL_URL" \
    && python3 -m zipfile -e vosk_model.zip /tmp/ \
    && mv "/tmp/${MODEL_NAME}" "${PLUGIN_DIR}/model" \
    && rm -f vosk_model.zip \
    || echo "ERROR: no se pudo descargar/descomprimir el modelo"
fi
chown -R volumio:volumio "${PLUGIN_DIR}" 2>/dev/null

echo "== Comprobacion =="
command -v ffmpeg >/dev/null && echo "ffmpeg OK" || echo "ffmpeg FALTA"
as_volumio "python3 -c 'import vosk'" 2>/dev/null && echo "vosk OK" || echo "vosk FALTA"
[ -d "${PLUGIN_DIR}/model" ] && echo "modelo OK" || echo "modelo FALTA"

echo "plugininstallend"
