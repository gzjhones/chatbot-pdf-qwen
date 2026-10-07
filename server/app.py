import os
import json
import base64
import tempfile

import fitz          # PyMuPDF
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "config.json")

def load_config() -> dict:
    """Lee config.json; las variables de entorno tienen prioridad.

    OLLAMA_URL   → URL de Ollama (por defecto la de config.json)
    MODEL_NAME   → modelo de Ollama
    """
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["ollama_url"] = os.environ.get("OLLAMA_URL", cfg.get("ollama_url", "http://localhost:11434"))
    cfg["model_name"] = os.environ.get("MODEL_NAME", cfg["model_name"])
    return cfg

config = load_config()

# Puerto y clave opcional (para no dejar la GPU abierta a cualquiera)
PORT    = int(os.environ.get("PORT", 5050))
API_KEY = os.environ.get("API_KEY", "")

# ---------------------------------------------------------------------------
# System prompt maestro
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """\
Eres un analizador experto de documentos. Tu tarea es revisar el texto \
del PDF enviado e identificar las siguientes secciones:

1. OBJETIVOS: Identifica si el documento tiene una sección de objetivos \
(puede llamarse: objetivo, propósito, finalidad, alcance, metas).
Si la tiene, extrae su contenido. Si no, indica que no se encontró \
y sugiere dónde podría incluirse.

2. CONCLUSIONES: Identifica si el documento tiene conclusiones \
(puede llamarse: conclusiones, resultados, hallazgos, cierre, resumen final).
Si las tiene, extrae su contenido. Si no, da tus observaciones sobre \
el documento y sugiere qué conclusiones podría incluir.

Al final, da una valoración general del documento de 1 a 5 estrellas \
según su estructura y completitud.\
"""

# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
def pdf_base64_to_text(b64_string: str) -> str:
    """Decodifica un PDF en base64 y extrae el texto con PyMuPDF."""
    pdf_bytes = base64.b64decode(b64_string)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name
    try:
        doc = fitz.open(tmp_path)
        text = "\n".join(page.get_text() for page in doc)
        doc.close()
        return text
    finally:
        os.unlink(tmp_path)


def call_ollama(document_text: str, cfg: dict) -> str:
    """Llama a Ollama /api/chat y devuelve el texto de la respuesta."""
    url = cfg["ollama_url"].rstrip("/") + "/api/chat"
    payload = {
        "model": cfg["model_name"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": document_text[:6000]},
        ],
        "stream": False,
        "options": {
            "num_predict": cfg.get("max_tokens", 1024),
            "temperature": cfg.get("temperature", 0.7),
        },
    }
    resp = requests.post(url, json=payload, timeout=300)
    resp.raise_for_status()
    data = resp.json()
    return data["message"]["content"]


def parse_analysis(raw: str) -> dict:
    """Extrae objetivos, conclusiones y valoración del texto generado."""
    objetivos    = []
    conclusiones = []
    valoracion   = []
    current      = None

    for line in raw.splitlines():
        low = line.lower()
        if any(k in low for k in ("objetivo", "propósito", "finalidad", "alcance", "metas")):
            current = "objetivos"
        elif any(k in low for k in ("conclusi", "resultado", "hallazgo", "cierre", "resumen final")):
            current = "conclusiones"
        elif any(k in low for k in ("valoraci", "estrella", "calificaci")) or "★" in line:
            current = "valoracion"

        if current == "objetivos":
            objetivos.append(line)
        elif current == "conclusiones":
            conclusiones.append(line)
        elif current == "valoracion":
            valoracion.append(line)

    # Si el parser no encontró secciones, devuelve todo en objetivos
    if not objetivos and not conclusiones:
        return {
            "objetivos":    raw.strip(),
            "conclusiones": "(ver texto completo)",
            "valoracion":   "(no identificada)",
        }

    return {
        "objetivos":    "\n".join(objetivos).strip()    or "(no identificado)",
        "conclusiones": "\n".join(conclusiones).strip() or "(no identificado)",
        "valoracion":   "\n".join(valoracion).strip()   or "(no identificada)",
    }


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)
# CORS abierto: la página se abre en local (file:// u origen localhost)
# y llama a un dominio público (trycloudflare / ngrok / runpod proxy).
CORS(app, resources={r"/*": {"origins": "*"}},
     allow_headers=["Content-Type", "X-API-Key", "ngrok-skip-browser-warning"])
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB (PDF en base64)


@app.before_request
def check_api_key():
    """Si API_KEY está definida, exige la cabecera X-API-Key (salvo preflight)."""
    if not API_KEY or request.method == "OPTIONS":
        return None
    if request.headers.get("X-API-Key") != API_KEY:
        return jsonify({"error": "API key inválida o ausente"}), 401
    return None


@app.route("/health", methods=["GET"])
def health():
    cfg = load_config()
    # Comprueba que Ollama responde
    try:
        r = requests.get(cfg["ollama_url"] + "/api/tags", timeout=5)
        ollama_ok = r.ok
        models = [m["name"] for m in r.json().get("models", [])]
    except Exception:
        ollama_ok = False
        models = []
    return jsonify({
        "status":     "ok",
        "modelo":     cfg["model_name"],
        "ollama_ok":  ollama_ok,
        "modelos_disponibles": models,
    })


@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.get_json(force=True, silent=True) or {}

    pdf_b64 = data.get("pdf_base64")
    if not pdf_b64:
        return jsonify({"error": "Se requiere el campo 'pdf_base64'"}), 400

    # Extrae texto del PDF
    try:
        texto = pdf_base64_to_text(pdf_b64)
    except Exception as exc:
        return jsonify({"error": f"Error al procesar el PDF: {exc}"}), 422

    # Lee config en cada request para reflejar cambios sin reiniciar
    cfg = load_config()

    # Llama a Ollama
    try:
        raw_response = call_ollama(texto, cfg)
    except requests.exceptions.ConnectionError:
        return jsonify({"error": f"No se puede conectar a Ollama en {cfg['ollama_url']}. ¿Está corriendo 'ollama serve'?"}), 503
    except requests.exceptions.HTTPError as exc:
        return jsonify({"error": f"Error de Ollama: {exc}"}), 502
    except Exception as exc:
        return jsonify({"error": f"Error al generar análisis: {exc}"}), 500

    parsed = parse_analysis(raw_response)

    return jsonify({
        "objetivos":      parsed["objetivos"],
        "conclusiones":   parsed["conclusiones"],
        "valoracion":     parsed["valoracion"],
        "texto_completo": texto[:3000],
        "modelo_usado":   cfg["model_name"],
    })


# ---------------------------------------------------------------------------
# Arranque
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    cfg = load_config()
    print(f"[INFO] Modelo configurado : {cfg['model_name']}")
    print(f"[INFO] Ollama URL         : {cfg['ollama_url']}")
    print(f"[INFO] Servidor en        : http://0.0.0.0:{PORT}")
    print(f"[INFO] API key            : {'activada' if API_KEY else 'desactivada'}")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
