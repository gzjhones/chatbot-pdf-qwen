"""
Revisor ortográfico de PDF — Flask + Ollama

Flujo:
  POST /analyze         {pdf_base64}      → {job_id}          (responde al instante)
  GET  /jobs/<job_id>                     → {estado, progreso, total, resultado}
  GET  /health

El PDF se divide en bloques; cada bloque se revisa por separado con Ollama
en un hilo de fondo. Así ninguna petición HTTP dura más de unos segundos
(los túneles de Cloudflare y el proxy de RunPod cortan a ~100 s).
"""
import os
import re
import json
import time
import uuid
import base64
import threading
import unicodedata

import fitz          # PyMuPDF
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
BASE_DIR    = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
PROMPT_PATH = os.environ.get("PROMPT_FILE", os.path.join(BASE_DIR, "prompt.txt"))


def load_config() -> dict:
    """Lee config.json; las variables de entorno tienen prioridad."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["ollama_url"] = os.environ.get("OLLAMA_URL", cfg.get("ollama_url", "http://localhost:11434"))
    cfg["model_name"] = os.environ.get("MODEL_NAME", cfg["model_name"])
    cfg.setdefault("max_tokens", 1024)
    cfg.setdefault("temperature", 0.1)     # baja: queremos correcciones, no creatividad
    cfg.setdefault("chunk_chars", 2500)    # tamaño de cada bloque de texto
    cfg.setdefault("max_chunks", 40)       # tope de bloques por documento
    cfg.setdefault("num_ctx", 8192)        # contexto de Ollama
    return cfg


PORT    = int(os.environ.get("PORT", 5050))
API_KEY = os.environ.get("API_KEY", "")

# ---------------------------------------------------------------------------
# Prompt maestro (se puede sobrescribir con prompt.txt sin reiniciar)
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """\
Eres un corrector ortográfico profesional de textos en español.
Recibirás un fragmento de un documento. Revisa ÚNICAMENTE la ortografía:
- tildes (acentuación),
- letras equivocadas, omitidas o sobrantes,
- uso de mayúsculas,
- signos de puntuación básicos (¿?, ¡!, comas evidentes).

NO resumas, NO opines sobre el contenido, NO cambies el estilo ni el vocabulario.
Ignora nombres propios, siglas, fórmulas, URLs, referencias bibliográficas y
palabras en otros idiomas.

Responde EXACTAMENTE con este formato y nada más:

ERRORES:
- palabra_incorrecta → palabra_correcta
(si no hay errores escribe solamente: - Ninguno)

CORRECCIONES:
- oración completa ya corregida
(solo las oraciones que tenían errores; si no hay, escribe: - Ninguna)
"""


def load_prompt() -> str:
    """Usa prompt.txt si existe y no está vacío; si no, SYSTEM_PROMPT."""
    try:
        with open(PROMPT_PATH, "r", encoding="utf-8") as f:
            txt = f.read().strip()
            return txt or SYSTEM_PROMPT
    except FileNotFoundError:
        return SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# Extracción y limpieza del texto del PDF
# ---------------------------------------------------------------------------
def pdf_base64_to_text(b64_string: str) -> str:
    pdf_bytes = base64.b64decode(b64_string)
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        return "\n".join(page.get_text() for page in doc)


def clean_text(text: str) -> str:
    """Quita artefactos de la extracción que el modelo marcaría como errores."""
    text = unicodedata.normalize("NFKC", text)          # ligaduras ﬁ ﬂ → fi fl
    text = text.replace("­", "")                   # guion blando
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)         # pala-\nbra → palabra
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"(?<![.:;?!])\n(?!\n)", " ", text)    # une líneas cortadas
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_chunks(text: str, size: int) -> list:
    """Divide en bloques de ~size caracteres sin cortar oraciones."""
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    chunks, current = [], ""
    for s in sentences:
        if len(current) + len(s) + 1 > size and current:
            chunks.append(current.strip())
            current = ""
        while len(s) > size:                 # oración gigante (tablas, listas)
            chunks.append(s[:size])
            s = s[size:]
        current += s + " "
    if current.strip():
        chunks.append(current.strip())
    return chunks


# ---------------------------------------------------------------------------
# Llamada a Ollama y parseo
# ---------------------------------------------------------------------------
def call_ollama(fragment: str, cfg: dict) -> str:
    url = cfg["ollama_url"].rstrip("/") + "/api/chat"
    payload = {
        "model": cfg["model_name"],
        "messages": [
            {"role": "system", "content": load_prompt()},
            {"role": "user",   "content": "Fragmento a revisar:\n\n" + fragment},
        ],
        "stream": False,
        "think": False,                      # qwen3: sin bloque de razonamiento
        "options": {
            "num_predict": cfg["max_tokens"],
            "temperature": cfg["temperature"],
            "num_ctx":     cfg["num_ctx"],
        },
    }
    resp = requests.post(url, json=payload, timeout=300)
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    # Por si la versión de Ollama ignora "think"
    return re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()


NONE_WORDS = {"ninguno", "ninguna", "no hay errores", "sin errores", "n/a", ""}
ARROW = re.compile(r"\s*(?:→|->|=>|⇒)\s*")


def parse_block(raw: str) -> tuple:
    """Devuelve (errores, correcciones) de la respuesta de un bloque."""
    errores, correcciones, section = [], [], None
    for line in raw.splitlines():
        low = line.strip().lower().strip("*#: ")
        if low.startswith("errores"):
            section = "e"; continue
        if low.startswith("correcci"):
            section = "c"; continue
        item = re.sub(r"^\s*(?:(?:[-•*]|\d+[.)])\s*)+", "", line).strip().strip("*")
        if item.lower().strip(". ") in NONE_WORDS:
            continue
        if section == "e" and ARROW.search(item):
            mal, bien = ARROW.split(item, maxsplit=1)
            mal, bien = mal.strip(' "\'`*_'), bien.strip(' "\'`*_')
            # Descarta "correcciones" que no cambian nada (ruido típico de LLM)
            if mal and bien and mal != bien:
                errores.append((mal, bien))
        elif section == "c" and len(item) > 3:
            correcciones.append(item)
    return errores, correcciones


def rating(n_errors: int, n_words: int) -> tuple:
    """Estrellas según errores por cada 1000 palabras."""
    per_k = n_errors * 1000 / max(n_words, 1)
    if per_k <= 1:   stars = 5
    elif per_k <= 3: stars = 4
    elif per_k <= 6: stars = 3
    elif per_k <= 10: stars = 2
    else:            stars = 1
    return stars, per_k


# ---------------------------------------------------------------------------
# Trabajos en segundo plano
# ---------------------------------------------------------------------------
JOBS = {}
JOBS_LOCK = threading.Lock()


def run_job(job_id: str, texto: str, cfg: dict):
    job = JOBS[job_id]
    try:
        chunks = split_chunks(texto, cfg["chunk_chars"])
        truncado = len(chunks) > cfg["max_chunks"]
        chunks = chunks[: cfg["max_chunks"]]
        job["total"] = len(chunks)

        errores, correcciones, vistos = [], [], set()
        for i, chunk in enumerate(chunks, 1):
            job["progreso"] = i
            raw = call_ollama(chunk, cfg)
            e, c = parse_block(raw)
            for mal, bien in e:
                key = (mal.lower(), bien.lower())
                if key not in vistos:
                    vistos.add(key)
                    errores.append(f"- **{mal}** → {bien}  (bloque {i})")
            correcciones += [f"- {x}" for x in c]

        n_words = len(texto.split())
        stars, per_k = rating(len(vistos), n_words)
        revisado = sum(len(c.split()) for c in chunks)
        valoracion = (
            f"{'★' * stars}{'☆' * (5 - stars)}  ({stars}/5)\n\n"
            f"- Errores únicos: **{len(vistos)}**\n"
            f"- Palabras revisadas: **{revisado}** de {n_words}\n"
            f"- Densidad: **{per_k:.1f}** errores por cada 1000 palabras"
        )
        if truncado:
            valoracion += (f"\n- ⚠️ Documento largo: solo se revisaron los primeros "
                           f"{cfg['max_chunks']} bloques (sube `max_chunks` en config.json)")

        job["resultado"] = {
            "errores":        "\n".join(errores) or "✅ No se encontraron errores ortográficos.",
            "correcciones":   "\n".join(correcciones) or "Sin oraciones que corregir.",
            "valoracion":     valoracion,
            "estrellas":      stars,
            "texto_completo": texto[:5000],
            "modelo_usado":   cfg["model_name"],
        }
        job["estado"] = "listo"
    except requests.exceptions.ConnectionError:
        job["estado"], job["error"] = "error", f"No se puede conectar a Ollama en {cfg['ollama_url']}"
    except Exception as exc:
        job["estado"], job["error"] = "error", f"Error al revisar: {exc}"


def purge_old_jobs(max_age=3600):
    now = time.time()
    with JOBS_LOCK:
        for k in [k for k, j in JOBS.items() if now - j["creado"] > max_age]:
            JOBS.pop(k, None)


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}},
     allow_headers=["Content-Type", "X-API-Key", "ngrok-skip-browser-warning"])
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024


@app.before_request
def check_api_key():
    if not API_KEY or request.method == "OPTIONS":
        return None
    if request.headers.get("X-API-Key") != API_KEY:
        return jsonify({"error": "API key inválida o ausente"}), 401
    return None


@app.route("/health", methods=["GET"])
def health():
    cfg = load_config()
    try:
        r = requests.get(cfg["ollama_url"] + "/api/tags", timeout=5)
        ollama_ok = r.ok
        models = [m["name"] for m in r.json().get("models", [])]
    except Exception:
        ollama_ok, models = False, []
    return jsonify({
        "status": "ok",
        "modo": "revisor_ortografico",
        "modelo": cfg["model_name"],
        "ollama_ok": ollama_ok,
        "modelos_disponibles": models,
        "prompt_personalizado": os.path.exists(PROMPT_PATH),
    })


@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.get_json(force=True, silent=True) or {}
    pdf_b64 = data.get("pdf_base64")
    if not pdf_b64:
        return jsonify({"error": "Se requiere el campo 'pdf_base64'"}), 400
    try:
        texto = clean_text(pdf_base64_to_text(pdf_b64))
    except Exception as exc:
        return jsonify({"error": f"Error al procesar el PDF: {exc}"}), 422
    if not texto:
        return jsonify({"error": "El PDF no tiene texto extraíble (¿es un escaneo?)"}), 422

    purge_old_jobs()
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"estado": "procesando", "progreso": 0, "total": 0,
                    "creado": time.time(), "resultado": None, "error": None}
    threading.Thread(target=run_job, args=(job_id, texto, load_config()), daemon=True).start()
    return jsonify({"job_id": job_id}), 202


@app.route("/jobs/<job_id>", methods=["GET"])
def job_status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Trabajo no encontrado (¿se reinició el servidor?)"}), 404
    return jsonify({k: job[k] for k in ("estado", "progreso", "total", "resultado", "error")})


if __name__ == "__main__":
    cfg = load_config()
    print(f"[INFO] Modo               : revisor ortográfico")
    print(f"[INFO] Modelo configurado : {cfg['model_name']}")
    print(f"[INFO] Ollama URL         : {cfg['ollama_url']}")
    print(f"[INFO] Prompt             : {'prompt.txt' if os.path.exists(PROMPT_PATH) else 'SYSTEM_PROMPT por defecto'}")
    print(f"[INFO] Servidor en        : http://0.0.0.0:{PORT}")
    print(f"[INFO] API key            : {'activada' if API_KEY else 'desactivada'}")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
