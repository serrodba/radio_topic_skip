#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
topic_worker.py - Detector de tematica en un stream de radio.

Lee el stream con ffmpeg (16 kHz, mono, PCM 16 bits), lo transcribe con
Vosk (offline) y cada CHUNK segundos emite una linea JSON por stdout:

  {"type":"chunk","secs":10,"hits":3,"matched":["gol","penalti","arbitro"],
   "is_topic":true,"text":"..."}

El plugin de Volumio (index.js) lee estas lineas y decide si cambia de emisora.
Tambien se puede ejecutar a mano para probar:

  python3 topic_worker.py --url http://... --model ./model --keywords keywords_futbol.txt
  python3 topic_worker.py --text "gol de penalti en el minuto 90" --keywords keywords_futbol.txt
"""
import argparse
import json
import re
import subprocess
import sys
import unicodedata

SAMPLE_RATE = 16000
BYTES_PER_SEC = SAMPLE_RATE * 2  # s16le mono


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def normalize(text):
    """Minusculas, sin tildes, solo letras/numeros/espacios."""
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return " " + re.sub(r"\s+", " ", text).strip() + " "


def load_keywords(path):
    """Una palabra o expresion por linea. Formato opcional 'expresion;peso'.
    Lineas vacias o que empiezan por # se ignoran."""
    kws = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            weight = 1.0
            if ";" in line:
                line, w = line.rsplit(";", 1)
                try:
                    weight = float(w)
                except ValueError:
                    weight = 1.0
            norm = normalize(line).strip()
            if norm:
                kws.append((line.strip(), " " + norm + " ", weight))
    return kws


def score(text, keywords):
    """Devuelve (puntuacion, lista de expresiones encontradas).
    Cada expresion cuenta una sola vez por bloque (evita que una palabra
    repetida dispare la deteccion)."""
    norm = normalize(text)
    matched, total = [], 0.0
    for original, needle, weight in keywords:
        if needle in norm:
            matched.append(original)
            total += weight
    return total, matched


UA = "VLC/3.0.18 LibVLC/3.0.18"
AUDIO_CT = ("audio/mpeg", "audio/aac", "audio/aacp", "audio/ogg", "application/ogg",
            "audio/opus", "audio/flac", "audio/x-flac", "audio/mp4", "audio/wav")


def _first_url_in(text):
    """Primera URL de un .pls ([playlist] FileN=...) o .m3u (lineas sin #)."""
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if "=" in line and line.lower().startswith("file"):
            line = line.split("=", 1)[1].strip()
        if line.lower().startswith(("http://", "https://")):
            return line
    return None


def resolve_url(url, depth=0):
    """Si la URL es una lista .pls/.m3u, devuelve el stream real.
    Los HLS (.m3u8 con #EXT-X-) y el audio directo se devuelven tal cual."""
    if depth > 3 or not url.lower().startswith(("http://", "https://")):
        return url
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Icy-MetaData": "0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            final = r.geturl()
            ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ct in AUDIO_CT and "mpegurl" not in ct:
                return final                    # ya es audio
            body = r.read(65536).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        emit({"type": "warn", "msg": "no se pudo resolver %s: %s" % (url, e)})
        return url
    if "#EXT-X-" in body:                       # HLS: ffmpeg lo entiende
        return final
    inner = _first_url_in(body)
    if inner:
        return resolve_url(inner, depth + 1)
    return final


def run_text(args, keywords):
    total, matched = score(args.text, keywords)
    emit({"type": "chunk", "secs": 0, "hits": total, "matched": matched,
          "is_topic": total >= args.min_hits, "text": args.text})


def run_stream(args, keywords):
    """Lectura y reconocimiento desacoplados:
    - Un hilo lee ffmpeg sin parar y guarda SOLO los ultimos CHUNK segundos
      (buffer circular). Asi el stream nunca se atasca.
    - El hilo principal toma el audio mas reciente, lo reconoce y emite el
      resultado. Si la CPU es lenta (Pi 3), se descarta el audio que no da
      tiempo a procesar: se analiza siempre "lo que suena ahora".
    - "secs" del resultado = tiempo REAL transcurrido desde el bloque anterior,
      para que la ventana del plugin mida tiempo de reloj.
    """
    import collections
    import threading
    import time

    try:
        from vosk import Model, KaldiRecognizer, SetLogLevel
    except ImportError:
        emit({"type": "error", "msg": "vosk no esta instalado (pip3 install vosk)"})
        return 2
    SetLogLevel(-1)
    try:
        model = Model(args.model)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "msg": "no se pudo cargar el modelo: %s" % e})
        return 2

    url = resolve_url(args.url)
    cmd = [args.ffmpeg, "-nostdin", "-loglevel", "error"]
    if args.realtime:
        cmd += ["-re"]                      # solo para pruebas con ficheros locales
    if url.lower().startswith(("http://", "https://")):
        # Solo validas para streams http(s)
        cmd += ["-user_agent", UA,
                "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"]
    cmd += ["-i", url, "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-f", "s16le", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    emit({"type": "ready", "url": url})

    piece = 4000                                    # 0,125 s
    chunk_pieces = max(1, int(args.chunk * BYTES_PER_SEC / piece))
    buf = collections.deque(maxlen=chunk_pieces)    # solo el audio mas reciente
    cond = threading.Condition()
    state = {"eof": False, "new": 0}

    def reader():
        while True:
            data = proc.stdout.read(piece)
            with cond:
                if not data:
                    state["eof"] = True
                    cond.notify_all()
                    return
                buf.append(data)
                state["new"] += 1
                cond.notify_all()

    threading.Thread(target=reader, daemon=True).start()
    last = time.monotonic()
    first = True
    try:
        while True:
            with cond:
                # Espera a tener un bloque completo de audio NUEVO
                while state["new"] < chunk_pieces and not state["eof"]:
                    cond.wait(1.0)
                if state["eof"]:
                    err = proc.stderr.read().decode("utf-8", "replace").strip()[-400:]
                    emit({"type": "error",
                          "msg": "el stream se ha cortado. ffmpeg: " + (err or "(sin mensaje)")})
                    return 1
                audio = b"".join(buf)
                buf.clear()
                state["new"] = 0

            t0 = time.monotonic()
            rec = KaldiRecognizer(model, SAMPLE_RATE)
            texts = []
            for i in range(0, len(audio), piece):
                if rec.AcceptWaveform(audio[i:i + piece]):
                    t = json.loads(rec.Result()).get("text", "")
                    if t:
                        texts.append(t)
            t = json.loads(rec.FinalResult()).get("text", "")
            if t:
                texts.append(t)
            text = " ".join(texts)
            total, matched = score(text, keywords)

            now = time.monotonic()
            audio_secs = len(audio) / BYTES_PER_SEC
            wall = audio_secs if first else now - last
            first, last = False, now
            emit({"type": "chunk", "secs": round(wall, 1), "audio_secs": round(audio_secs, 1),
                  "proc_secs": round(now - t0, 1),
                  "hits": total, "matched": matched,
                  "is_topic": total >= args.min_hits,
                  "text": text[-300:]})
            if args.pause > 0:
                time.sleep(args.pause)
    except KeyboardInterrupt:
        return 0
    finally:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", help="URL del stream de radio")
    p.add_argument("--text", help="Modo prueba: puntua este texto y sale")
    p.add_argument("--model", default="model", help="Carpeta del modelo Vosk")
    p.add_argument("--keywords", required=True, help="Fichero de palabras clave")
    p.add_argument("--chunk", type=float, default=15.0, help="Segundos por bloque")
    p.add_argument("--min-hits", type=float, default=2.0,
                   help="Puntuacion minima para marcar un bloque como tematico")
    p.add_argument("--pause", type=float, default=0.0,
                   help="Segundos de descanso entre bloques (ahorra CPU)")
    p.add_argument("--realtime", action="store_true",
                   help="Pruebas: lee un fichero local a velocidad real (-re)")
    p.add_argument("--ffmpeg", default="ffmpeg")
    args = p.parse_args()

    keywords = load_keywords(args.keywords)
    if args.text is not None:
        return run_text(args, keywords) or 0
    if not args.url:
        p.error("indica --url o --text")
    return run_stream(args, keywords)


if __name__ == "__main__":
    sys.exit(main() or 0)
